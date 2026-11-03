import type { D1Database } from '@cloudflare/workers-types';
import { parseEmailAddress } from '$lib/email-address';
import { isMailCategory, type MailCategory } from '$lib/organizing/categories';
import { isFutureInstant } from '$lib/organizing/snooze';
import { expandToThreads } from '$lib/server/mail-store';

/** Bulk and single-message conversation actions. Both routes call these. */
export const CONVERSATION_ACTIONS = [
	'archive',
	'inbox',
	'important',
	'unimportant',
	'mute',
	'unmute',
	'snooze',
	'category',
	'label',
	'unlabel',
	'block',
	'unblock'
] as const;

export type ConversationAction = (typeof CONVERSATION_ACTIONS)[number];

export type ThreadColumnPatch = {
	in_inbox?: 0 | 1;
	category?: MailCategory;
	is_important?: 0 | 1;
	snoozed_until?: string | null;
	is_muted?: 0 | 1;
	is_spam?: 0 | 1;
	deleted_at?: string | null;
};

export type ConversationActionInput = {
	until?: string | null;
	category?: string | null;
	labelId?: string | null;
	address?: string | null;
};

export class OrganizingActionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'OrganizingActionError';
	}
}

export function isConversationAction(action: string | undefined): action is ConversationAction {
	return (
		typeof action === 'string' &&
		(CONVERSATION_ACTIONS as readonly string[]).includes(action)
	);
}

/**
 * Writes the same columns on every message in the selected conversations.
 * Moving to the inbox, marking spam, or trashing also clears a snooze.
 * Archive (`in_inbox = 0`) leaves `snoozed_until` alone.
 */
export async function setThreadColumns(
	db: D1Database,
	userId: string,
	messageIds: string[],
	patch: ThreadColumnPatch
): Promise<void> {
	const ids = await expandToThreads(db, userId, messageIds);
	if (ids.length === 0) return;

	const { clauses, bindings } = columnAssignments(patch);
	if (clauses.length === 0) return;

	const marks = placeholders(ids.length);
	await db
		.prepare(
			`UPDATE emails SET ${clauses.join(', ')}
			 WHERE user_id = ? AND id IN (${marks})`
		)
		.bind(...bindings, userId, ...ids)
		.run();
}

/**
 * Adds or removes one label on each selected conversation.
 * A child label does not pull in its parent. The label must belong to the user.
 */
export async function setThreadLabels(
	db: D1Database,
	userId: string,
	messageIds: string[],
	labelId: string,
	on: boolean
): Promise<void> {
	const ids = await expandToThreads(db, userId, messageIds);
	if (ids.length === 0) return;

	const owned = await db
		.prepare('SELECT id FROM labels WHERE id = ? AND user_id = ?')
		.bind(labelId, userId)
		.first<{ id: string }>();
	if (!owned) {
		throw new OrganizingActionError('Unknown label');
	}

	const marks = placeholders(ids.length);
	const { results } = await db
		.prepare(
			`SELECT DISTINCT COALESCE(thread_id, id) AS thread_id
			 FROM emails
			 WHERE user_id = ? AND id IN (${marks})`
		)
		.bind(userId, ...ids)
		.all<{ thread_id: string }>();

	const threadIds = [...new Set(results.map((row) => row.thread_id))];
	if (threadIds.length === 0) return;

	const statement = on
		? `INSERT OR IGNORE INTO thread_labels (user_id, thread_id, label_id) VALUES (?, ?, ?)`
		: `DELETE FROM thread_labels WHERE user_id = ? AND thread_id = ? AND label_id = ?`;

	await db.batch(
		threadIds.map((threadId) => db.prepare(statement).bind(userId, threadId, labelId))
	);
}

/** Remembers the category chosen for a sender. Later mail from that address inherits it. */
export async function rememberSenderCategory(
	db: D1Database,
	userId: string,
	fromAddr: string,
	category: MailCategory
): Promise<void> {
	const address = bareMailbox(fromAddr);
	if (!address) return;

	await db
		.prepare(
			`INSERT INTO sender_categories (user_id, from_addr, category) VALUES (?, ?, ?)
			 ON CONFLICT(user_id, from_addr) DO UPDATE SET category = excluded.category`
		)
		.bind(userId, address, category)
		.run();
}

/** Inserts one exact mailbox address. Does not insert a domain. */
export async function blockAddress(db: D1Database, userId: string, address: string): Promise<void> {
	const bare = bareMailbox(address);
	if (!bare) {
		throw new OrganizingActionError('Cannot block a domain');
	}

	await db
		.prepare(
			`INSERT INTO blocked_senders (user_id, address) VALUES (?, ?)
			 ON CONFLICT(user_id, address) DO NOTHING`
		)
		.bind(userId, bare)
		.run();
}

/** Removes one blocked mailbox address. */
export async function unblockAddress(
	db: D1Database,
	userId: string,
	address: string
): Promise<void> {
	const bare = bareMailbox(address);
	if (!bare) return;

	await db
		.prepare('DELETE FROM blocked_senders WHERE user_id = ? AND address = ?')
		.bind(userId, bare)
		.run();
}

/**
 * Shared by the list toolbar and the open conversation so both write the same rows.
 * Returns how many message rows the conversation covers, or 0 when none belong to the user.
 */
export async function applyConversationAction(
	db: D1Database,
	userId: string,
	messageIds: string[],
	action: ConversationAction,
	input: ConversationActionInput
): Promise<number> {
	if (action === 'snooze' && input.until != null) {
		if (typeof input.until !== 'string' || !isFutureInstant(input.until, new Date())) {
			throw new OrganizingActionError('Snooze time must be in the future');
		}
	}
	if (action === 'category' && !isMailCategory(input.category)) {
		throw new OrganizingActionError('Unknown category');
	}
	if (
		(action === 'label' || action === 'unlabel') &&
		(typeof input.labelId !== 'string' || input.labelId.length === 0)
	) {
		throw new OrganizingActionError('Unknown label');
	}

	const ids = await expandToThreads(db, userId, messageIds);
	if (ids.length === 0) return 0;

	switch (action) {
		case 'archive':
			await setThreadColumns(db, userId, ids, { in_inbox: 0 });
			return ids.length;
		case 'inbox':
			await setThreadColumns(db, userId, ids, { in_inbox: 1 });
			return ids.length;
		case 'important':
			await setThreadColumns(db, userId, ids, { is_important: 1 });
			return ids.length;
		case 'unimportant':
			await setThreadColumns(db, userId, ids, { is_important: 0 });
			return ids.length;
		case 'mute':
			await setThreadColumns(db, userId, ids, { is_muted: 1, in_inbox: 0 });
			return ids.length;
		case 'unmute':
			await setThreadColumns(db, userId, ids, { is_muted: 0 });
			return ids.length;
		case 'snooze':
			await setThreadColumns(db, userId, ids, { snoozed_until: input.until ?? null });
			return ids.length;
		case 'category': {
			const category = input.category;
			if (!isMailCategory(category)) {
				throw new OrganizingActionError('Unknown category');
			}
			const senders = await newestInboundSenders(db, userId, ids);
			await setThreadColumns(db, userId, ids, { category });
			for (const address of senders) {
				await rememberSenderCategory(db, userId, address, category);
			}
			return ids.length;
		}
		case 'label':
			await setThreadLabels(db, userId, ids, input.labelId ?? '', true);
			return ids.length;
		case 'unlabel':
			await setThreadLabels(db, userId, ids, input.labelId ?? '', false);
			return ids.length;
		case 'block': {
			const senders = await sendersToBlock(db, userId, ids, input.address);
			await setThreadColumns(db, userId, ids, { is_spam: 1, deleted_at: null });
			for (const address of senders) {
				await blockAddress(db, userId, address);
			}
			return ids.length;
		}
		case 'unblock': {
			for (const address of await sendersToUnblock(db, userId, ids, input.address)) {
				await unblockAddress(db, userId, address);
			}
			return ids.length;
		}
	}
}

function columnAssignments(patch: ThreadColumnPatch): { clauses: string[]; bindings: unknown[] } {
	const clauses: string[] = [];
	const bindings: unknown[] = [];

	if (patch.in_inbox !== undefined) {
		clauses.push('in_inbox = ?');
		bindings.push(patch.in_inbox);
	}
	if (patch.category !== undefined) {
		clauses.push('category = ?');
		bindings.push(patch.category);
	}
	if (patch.is_important !== undefined) {
		clauses.push('is_important = ?');
		bindings.push(patch.is_important);
	}
	if (patch.is_muted !== undefined) {
		clauses.push('is_muted = ?');
		bindings.push(patch.is_muted);
	}
	if (patch.is_spam !== undefined) {
		clauses.push('is_spam = ?');
		bindings.push(patch.is_spam);
	}
	if (patch.deleted_at !== undefined) {
		if (patch.deleted_at === null) {
			clauses.push('deleted_at = NULL');
		} else {
			clauses.push('deleted_at = ?');
			bindings.push(patch.deleted_at);
		}
	}

	const clearSnooze =
		patch.in_inbox === 1 ||
		patch.is_spam === 1 ||
		(typeof patch.deleted_at === 'string' && patch.deleted_at.length > 0);

	if (clearSnooze) {
		clauses.push('snoozed_until = NULL');
	} else if (patch.snoozed_until !== undefined) {
		if (patch.snoozed_until === null) {
			clauses.push('snoozed_until = NULL');
		} else {
			clauses.push('snoozed_until = ?');
			bindings.push(patch.snoozed_until);
		}
	}

	return { clauses, bindings };
}

/** Bare mailbox, or null when the value is a domain or otherwise not an address. */
function bareMailbox(value: string): string | null {
	const bare = parseEmailAddress(value);
	const at = bare.indexOf('@');
	if (at <= 0 || at !== bare.lastIndexOf('@') || at === bare.length - 1) return null;
	return bare;
}

function placeholders(count: number): string {
	return Array.from({ length: count }, () => '?').join(', ');
}

async function threadKeys(db: D1Database, userId: string, ids: string[]): Promise<string[]> {
	const marks = placeholders(ids.length);
	const { results } = await db
		.prepare(
			`SELECT DISTINCT COALESCE(thread_id, id) AS thread_id
			 FROM emails
			 WHERE user_id = ? AND id IN (${marks})`
		)
		.bind(userId, ...ids)
		.all<{ thread_id: string }>();
	return results.map((row) => row.thread_id);
}

type InboundCandidate = {
	id: string;
	thread_id: string;
	from_addr: string;
	created_at: string | null;
};

/**
 * Inbound rows in the selection. Each message id is bound once.
 * D1 allows 100 bound parameters, so the id list cannot appear twice.
 */
async function inboundCandidates(
	db: D1Database,
	userId: string,
	ids: string[]
): Promise<InboundCandidate[]> {
	if (ids.length === 0) return [];

	const marks = placeholders(ids.length);
	const { results } = await db
		.prepare(
			`SELECT e.id AS id,
			        COALESCE(e.thread_id, e.id) AS thread_id,
			        e.from_addr AS from_addr,
			        datetime(e.created_at) AS created_at
			 FROM emails e
			 WHERE e.user_id = ?
			   AND e.direction = 'inbound'
			   AND e.id IN (${marks})`
		)
		.bind(userId, ...ids)
		.all<InboundCandidate>();

	return results;
}

/** Later `datetime(created_at)` wins. The same second uses the greater id. */
function inboundIsNewer(candidate: InboundCandidate, current: InboundCandidate): boolean {
	if (candidate.created_at === null || current.created_at === null) return false;
	if (candidate.created_at !== current.created_at) {
		return candidate.created_at > current.created_at;
	}
	return candidate.id > current.id;
}

function newestInboundByThread(rows: InboundCandidate[]): Map<string, InboundCandidate> {
	const newest = new Map<string, InboundCandidate>();
	for (const row of rows) {
		const current = newest.get(row.thread_id);
		if (!current || inboundIsNewer(row, current)) {
			newest.set(row.thread_id, row);
		}
	}
	return newest;
}

/** One bare address per conversation that has an inbound sender. Conversations without one are omitted. */
async function newestInboundSenders(
	db: D1Database,
	userId: string,
	ids: string[]
): Promise<string[]> {
	const senders = new Set<string>();
	for (const row of newestInboundByThread(await inboundCandidates(db, userId, ids)).values()) {
		const bare = bareMailbox(row.from_addr);
		if (bare) senders.add(bare);
	}
	return [...senders];
}

async function userAddressSet(db: D1Database, userId: string): Promise<Set<string>> {
	const { results } = await db
		.prepare('SELECT address FROM addresses WHERE user_id = ?')
		.bind(userId)
		.all<{ address: string }>();
	return new Set(results.map((row) => parseEmailAddress(row.address)));
}

/**
 * Every selected conversation contributes its newest inbound sender.
 * A domain, a missing sender, or one of the user's own addresses refuses the whole block.
 */
async function sendersToBlock(
	db: D1Database,
	userId: string,
	ids: string[],
	requested: string | null | undefined
): Promise<string[]> {
	if (typeof requested === 'string' && requested.trim().length > 0 && !bareMailbox(requested)) {
		throw new OrganizingActionError('Cannot block a domain');
	}

	const threads = await threadKeys(db, userId, ids);
	const byThread = new Map<string, string | null>();
	for (const row of newestInboundByThread(await inboundCandidates(db, userId, ids)).values()) {
		byThread.set(row.thread_id, bareMailbox(row.from_addr));
	}

	const own = await userAddressSet(db, userId);
	const senders = new Set<string>();
	for (const threadId of threads) {
		const bare = byThread.get(threadId);
		if (!bare) {
			throw new OrganizingActionError(
				byThread.has(threadId) ? 'Cannot block a domain' : 'No sender to block'
			);
		}
		if (own.has(bare)) {
			throw new OrganizingActionError('Cannot block your own address');
		}
		senders.add(bare);
	}

	return [...senders];
}

async function sendersToUnblock(
	db: D1Database,
	userId: string,
	ids: string[],
	requested: string | null | undefined
): Promise<string[]> {
	if (typeof requested === 'string' && requested.trim().length > 0) {
		const bare = bareMailbox(requested);
		if (!bare) throw new OrganizingActionError('Cannot block a domain');
		return [bare];
	}

	const senders = await newestInboundSenders(db, userId, ids);
	if (senders.length === 0) {
		throw new OrganizingActionError('No sender to block');
	}
	return senders;
}
