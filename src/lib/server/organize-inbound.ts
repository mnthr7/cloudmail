import type { D1Database } from '@cloudflare/workers-types';
import { parseEmailAddress } from '#lib/email-address.ts';
import {
	assignCategory,
	isMailCategory,
	type CategoryHeaders,
	type MailCategory
} from '#lib/organizing/categories.ts';
import { enqueueMailRuns } from './agent-runs-store.ts';
import { filterMatches, type FilterMail, type FilterRule } from '#lib/organizing/filters.ts';
import { getUserById } from './auth';
import { getDefaultAddress } from './domains';
import type { EmailProvider } from './email-provider';
import { expandToThreads, setEmailFlags } from './mail-store';
import { setThreadColumns, setThreadLabels, type ThreadColumnPatch } from './organizing-store';
import { sendOutboundEmail } from './send-mail';

export type OrganizeInboundHeaders = CategoryHeaders & { hasAttachment: boolean };

/**
 * Actions from one filter. `actionForwardTo` is ignored here; the caller sends it.
 * Saving a filter and applying it to mail already filed uses this same function.
 */
export type FilterActionRule = {
	actionLabelId?: string | null;
	actionSkipInbox?: boolean;
	actionStar?: boolean;
	actionImportant?: boolean;
	actionMarkRead?: boolean;
	actionTrash?: boolean;
	actionCategory?: string | null;
	actionForwardTo?: string | null;
};

type FiledRow = {
	from_addr: string;
	to_addr: string;
	subject: string;
	body_text: string | null;
	direction: string;
	thread_id: string | null;
};

/** The fields a forward copies. Apply-to-existing passes the same shape as inbound filing. */
export type ForwardMail = {
	subject: string;
	body_text: string | null;
};

type SiblingFlags = {
	category: string;
	is_important: number;
	is_muted: number;
	snoozed_until: string | null;
	in_inbox: number;
};

type FilterRow = {
	id: string;
	match_from: string | null;
	match_to: string | null;
	match_subject: string | null;
	match_words: string | null;
	match_has_attachment: number;
	action_label_id: string | null;
	action_skip_inbox: number;
	action_star: number;
	action_important: number;
	action_mark_read: number;
	action_trash: number;
	action_category: string | null;
	action_forward_to: string | null;
};

/**
 * Files one stored message.
 *
 * Copies the conversation's inbox flag, category, importance, mute, and snooze
 * onto this row. Outbound mail stops there. It does not block, wake the thread,
 * clear another row's snooze, run filters, or forward. A blocked inbound sender
 * marks the conversation as spam and stops, without running filters or inserting
 * another block. Other inbound mail wakes an archived or snoozed conversation
 * unless it is muted, assigns a category, and runs enabled filters. Forwards
 * are sent after the row is filed; a send failure is logged and does not throw.
 */
export async function organizeInbound(
	db: D1Database,
	userId: string,
	emailId: string,
	headers: OrganizeInboundHeaders,
	provider?: EmailProvider
): Promise<void> {
	const row = await loadFiledRow(db, userId, emailId);
	if (!row) return;

	const sibling = await loadSiblingFlags(db, userId, emailId, row.thread_id);
	if (sibling) {
		await copySiblingFlags(db, userId, emailId, sibling);
	}

	// A sent reply only inherits the conversation flags, including in_inbox.
	// Blocking, waking, filters, and forwards stay on inbound mail.
	if (row.direction !== 'inbound') return;

	// The block row already exists. Filing must not insert another one.
	if (await senderIsBlocked(db, userId, row.from_addr)) {
		await setThreadColumns(db, userId, [emailId], { is_spam: 1 });
		return;
	}

	if (sibling?.is_muted === 1) {
		await setThreadColumns(db, userId, [emailId], { is_muted: 1, in_inbox: 0 });
	} else {
		// in_inbox = 1 also clears snoozed_until, so a reply wakes the conversation.
		await setThreadColumns(db, userId, [emailId], { in_inbox: 1 });
	}

	const category = await categoryForInbound(db, userId, row, headers);
	await setThreadColumns(db, userId, [emailId], { category });

	const forwards = await runFilters(db, userId, emailId, row, headers.hasAttachment);
	await forwardFiledMail(db, userId, emailId, row, forwards, provider);

	// Wake an agent watching this address (A5). Mail that was blocked or marked
	// spam returned above. A failure here must not undo the filing.
	try {
		await enqueueMailRuns(db, userId, emailId, headers);
	} catch (error) {
		console.error('Failed to queue agent run', emailId, error);
	}
}

/**
 * Applies one filter's label, skip-inbox, star, important, mark-read, trash,
 * and category onto the message's conversation. Does not send the forward.
 */
export async function applyFilterActions(
	db: D1Database,
	userId: string,
	emailId: string,
	rule: FilterActionRule
): Promise<void> {
	const labelId = rule.actionLabelId?.trim();
	if (labelId) {
		await setThreadLabels(db, userId, [emailId], labelId, true);
	}

	const patch: ThreadColumnPatch = {};
	if (rule.actionSkipInbox) patch.in_inbox = 0;
	if (rule.actionImportant) patch.is_important = 1;
	if (isMailCategory(rule.actionCategory)) patch.category = rule.actionCategory;
	if (patch.in_inbox !== undefined || patch.is_important !== undefined || patch.category) {
		await setThreadColumns(db, userId, [emailId], patch);
	}

	if (rule.actionStar || rule.actionMarkRead || rule.actionTrash) {
		// One expanded id list, bound once. Trash also clears a snooze.
		const ids = await expandToThreads(db, userId, [emailId]);
		await setEmailFlags(db, userId, ids, {
			isStarred: rule.actionStar ? true : undefined,
			isRead: rule.actionMarkRead ? true : undefined,
			trashed: rule.actionTrash ? true : undefined
		});
	}
}

/** Header value from a Resend map or a Cloudflare `Headers` object. Blank is null. */
export function readInboundHeader(
	headers: { get(name: string): string | null } | Record<string, string | null | undefined> | null | undefined,
	name: string
): string | null {
	if (!headers) return null;

	let value: string | null | undefined;
	if (typeof (headers as { get?: unknown }).get === 'function') {
		value = (headers as { get(name: string): string | null }).get(name);
	} else {
		const record = headers as Record<string, string | null | undefined>;
		const target = name.toLowerCase();
		const key = Object.keys(record).find((entry) => entry.toLowerCase() === target);
		value = key ? record[key] : null;
	}

	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}

async function loadFiledRow(
	db: D1Database,
	userId: string,
	emailId: string
): Promise<FiledRow | null> {
	return db
		.prepare(
			`SELECT from_addr, to_addr, subject, body_text, direction, thread_id
			 FROM emails WHERE id = ? AND user_id = ?`
		)
		.bind(emailId, userId)
		.first<FiledRow>();
}

/** Newest other message in the conversation. Its flags are the conversation's. */
async function loadSiblingFlags(
	db: D1Database,
	userId: string,
	emailId: string,
	threadId: string | null
): Promise<SiblingFlags | null> {
	return db
		.prepare(
			`SELECT category, is_important, is_muted, snoozed_until, in_inbox
			 FROM emails
			 WHERE user_id = ?
			   AND id != ?
			   AND COALESCE(thread_id, id) = ?
			 ORDER BY datetime(created_at) DESC, id DESC
			 LIMIT 1`
		)
		.bind(userId, emailId, threadId ?? emailId)
		.first<SiblingFlags>();
}

async function copySiblingFlags(
	db: D1Database,
	userId: string,
	emailId: string,
	sibling: SiblingFlags
): Promise<void> {
	await db
		.prepare(
			`UPDATE emails
			 SET category = ?, is_important = ?, is_muted = ?, snoozed_until = ?, in_inbox = ?
			 WHERE user_id = ? AND id = ?`
		)
		.bind(
			sibling.category,
			sibling.is_important,
			sibling.is_muted,
			sibling.snoozed_until,
			sibling.in_inbox,
			userId,
			emailId
		)
		.run();
}

async function senderIsBlocked(db: D1Database, userId: string, fromAddr: string): Promise<boolean> {
	const bare = parseEmailAddress(fromAddr);
	if (!bare.includes('@')) return false;

	const row = await db
		.prepare('SELECT address FROM blocked_senders WHERE user_id = ? AND address = ? LIMIT 1')
		.bind(userId, bare)
		.first<{ address: string }>();
	return Boolean(row);
}

async function categoryForInbound(
	db: D1Database,
	userId: string,
	row: FiledRow,
	headers: OrganizeInboundHeaders
): Promise<MailCategory> {
	const bare = parseEmailAddress(row.from_addr);
	const saved = bare.includes('@')
		? await db
				.prepare(
					'SELECT category FROM sender_categories WHERE user_id = ? AND from_addr = ? LIMIT 1'
				)
				.bind(userId, bare)
				.first<{ category: string }>()
		: null;

	if (saved && isMailCategory(saved.category)) return saved.category;

	return assignCategory(
		{
			listId: headers.listId,
			inReplyTo: headers.inReplyTo,
			references: headers.references,
			listUnsubscribe: headers.listUnsubscribe,
			precedence: headers.precedence,
			autoSubmitted: headers.autoSubmitted,
			from: row.from_addr
		},
		null
	);
}

async function runFilters(
	db: D1Database,
	userId: string,
	emailId: string,
	row: FiledRow,
	hasAttachment: boolean
): Promise<string[]> {
	const { results } = await db
		.prepare(
			`SELECT id, match_from, match_to, match_subject, match_words, match_has_attachment,
			        action_label_id, action_skip_inbox, action_star, action_important,
			        action_mark_read, action_trash, action_category, action_forward_to
			 FROM filters
			 WHERE user_id = ? AND enabled = 1
			 ORDER BY position ASC, id ASC`
		)
		.bind(userId)
		.all<FilterRow>();

	const mail: FilterMail = {
		from: row.from_addr,
		to: row.to_addr,
		subject: row.subject,
		bodyText: row.body_text ?? '',
		hasAttachment
	};
	const forwards: string[] = [];

	for (const filter of results) {
		if (!filterMatches(matchRule(filter), mail)) continue;
		await applyFilterActions(db, userId, emailId, actionRule(filter));
		const target = filter.action_forward_to?.trim();
		if (target) forwards.push(target);
	}

	return forwards;
}

function matchRule(filter: FilterRow): FilterRule {
	return {
		matchFrom: filter.match_from,
		matchTo: filter.match_to,
		matchSubject: filter.match_subject,
		matchWords: filter.match_words,
		matchHasAttachment: filter.match_has_attachment === 1
	};
}

function actionRule(filter: FilterRow): FilterActionRule {
	return {
		actionLabelId: filter.action_label_id,
		actionSkipInbox: filter.action_skip_inbox === 1,
		actionStar: filter.action_star === 1,
		actionImportant: filter.action_important === 1,
		actionMarkRead: filter.action_mark_read === 1,
		actionTrash: filter.action_trash === 1,
		actionCategory: filter.action_category,
		actionForwardTo: filter.action_forward_to
	};
}

/**
 * Forwards one filed message from the user's default address.
 * Subject is `Fwd: ` plus the original. Body is the plain text.
 * Returns how many sends failed. A failure is logged and does not throw.
 * The same helper files new mail and applies a filter to mail already filed,
 * so a second apply sends another copy.
 */
export async function forwardFiledMail(
	db: D1Database,
	userId: string,
	emailId: string,
	row: ForwardMail,
	targets: string[],
	provider: EmailProvider | undefined
): Promise<number> {
	if (targets.length === 0) return 0;

	if (!provider) {
		console.error('Failed to forward inbound mail', emailId, 'No sending provider');
		return targets.length;
	}

	const from = await getDefaultAddress(db, userId);
	if (!from) {
		console.error('Failed to forward inbound mail', emailId, 'No sending address');
		return targets.length;
	}

	const user = await getUserById(db, userId);
	const senderName = user?.name?.trim() || from.address;
	const subject = `Fwd: ${row.subject}`;
	const text = row.body_text ?? '';

	let failed = 0;
	for (const to of targets) {
		try {
			await sendOutboundEmail(provider, { from, senderName, to, subject, text });
		} catch (error) {
			failed += 1;
			console.error('Failed to forward inbound mail', emailId, to, error);
		}
	}
	return failed;
}
