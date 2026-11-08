import { json, type RequestHandler } from '@sveltejs/kit';
import {
	deleteEmailsPermanently,
	expandToThreads,
	getEmailForUser,
	listThreadLabels,
	listThreadMessages,
	markThreadRead,
	setEmailFlags
} from '#lib/server/mail-store.ts';
import { isMailCategory } from '#lib/organizing/categories.ts';
import { askableAgents } from '#lib/server/agent-runs-store.ts';
import {
	OrganizingActionError,
	applyConversationAction,
	isConversationAction,
	setThreadColumns
} from '#lib/server/organizing-store.ts';
import { resolveFromAddress } from '#lib/server/outbox.ts';
import { queueOutbound } from '#lib/server/queue-outbound.ts';
import { matchThreadReplyFrom, threadReceivedAtAddresses } from '#lib/reply-from.ts';
import { buildReferences, displaySubject } from '#lib/server/threads.ts';
import { replyRecipients } from '#lib/writing/recipients.ts';
import { forwardSubject, replySubject } from '#lib/writing/subject.ts';
import { holdUntil, scheduleError } from '#lib/writing/timing.ts';
import type { EmailRow } from '#lib/types.ts';
import { DEMO_MODE, DEMO_USER, generateDemoMessages, demoStore } from '#lib/server/demo.ts';

type ComposeMode = 'reply' | 'reply-all' | 'forward' | 'new';

type ReplyBody = {
	fromAddressId?: string;
	fromAddress?: string;
	to?: string;
	cc?: string;
	bcc?: string;
	subject?: string;
	text?: string;
	html?: string;
	mode?: ComposeMode;
	/** Schedule send. Absent means an undo hold, which may also archive. */
	sendAt?: string;
	archive?: boolean;
};

function isComposeMode(value: unknown): value is ComposeMode {
	return value === 'reply' || value === 'reply-all' || value === 'forward' || value === 'new';
}

export const GET: RequestHandler = async ({ params, locals, platform, url }) => {
	const db = platform?.env.DB;
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	// Demo mode: return fake thread
	// Demo mode is server-env only (DEMO_MODE="true"), never a URL param.
	const isDemoMode = DEMO_MODE;

	if (isDemoMode && locals.user.id === DEMO_USER.id) {
		const messages = generateDemoMessages(params.id!);
		if (messages.length === 0) {
			return json({ error: 'Not found' }, { status: 404 });
		}

		// Mark as read
		demoStore.updateThread(params.id!, { is_read: true });

		const stored = demoStore
			.getThreads()
			.find((thread) => thread.thread_id === params.id || thread.latest_id === params.id);

		return json({
			threadId: messages[0].thread_id,
			subject: displaySubject(messages[0].subject),
			messages,
			draft: null,
			inInbox: stored?.in_inbox ?? true,
			isMuted: stored?.is_muted ?? false,
			isImportant: stored?.is_important ?? false,
			category: stored?.category ?? 'primary',
			labels: stored?.labels ?? [],
			agents: []
		});
	}

	if (!db) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const email = await getEmailForUser(db, locals.user.id, params.id!);
	if (!email) {
		return json({ error: 'Not found' }, { status: 404 });
	}

	await markThreadRead(db, locals.user.id, email);
	const messages = await listThreadMessages(db, locals.user.id, email);
	const threadId = email.thread_id ?? email.id;
	const labels = await listThreadLabels(db, locals.user.id, threadId);
	// The reply box answers the newest message in the open conversation.
	const openMessageId = messages[messages.length - 1]?.id ?? email.id;
	const draft = await db
		.prepare(
			`SELECT id, to_addr, cc_addr, bcc_addr, subject, body_html, draft_action, status
			 FROM emails
			 WHERE user_id = ? AND source_email_id = ? AND status = 'draft'
			 ORDER BY datetime(created_at) DESC
			 LIMIT 1`
		)
		.bind(locals.user.id, openMessageId)
		.first<{
			id: string;
			to_addr: string;
			cc_addr: string | null;
			bcc_addr: string | null;
			subject: string;
			body_html: string | null;
			draft_action: string | null;
			status: string;
		}>();

	// Agents this user can hand the thread to, for the reader's "Ask an agent".
	const agents = await askableAgents(db, locals.user.id).catch(() => []);

	return json({
		threadId,
		subject: displaySubject(messages[0]?.subject ?? email.subject),
		messages,
		draft: draft ?? null,
		inInbox: email.in_inbox === 1,
		isMuted: email.is_muted === 1,
		isImportant: email.is_important === 1,
		category: isMailCategory(email.category) ? email.category : 'primary',
		labels,
		agents: agents.map((agent) => ({ id: agent.id, name: agent.name }))
	});
};

/** Flag toggles from the list and the reader — applied to the whole thread. */
export const PATCH: RequestHandler = async ({ params, request, locals, platform, url }) => {
	const db = platform?.env.DB;
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const body = (await request.json()) as {
		isRead?: boolean;
		isStarred?: boolean;
		trashed?: boolean;
		spam?: boolean;
		/** Set to limit the change to this one message instead of the thread. */
		messageOnly?: boolean;
		action?: string;
		until?: string;
		category?: string;
		labelId?: string;
		address?: string;
	};

	// Demo mode: update fake data
	// Demo mode is server-env only (DEMO_MODE="true"), never a URL param.
	const isDemoMode = DEMO_MODE;

	if (isDemoMode && locals.user.id === DEMO_USER.id) {
		if (isConversationAction(body.action)) {
			return json({ error: 'Demo mode is read-only' }, { status: 403 });
		}

		const updates: Record<string, boolean> = {};
		if (body.isRead !== undefined) updates.is_read = body.isRead;
		if (body.isStarred !== undefined) updates.is_starred = body.isStarred;
		if (body.trashed !== undefined) updates.trashed = body.trashed;
		if (body.spam !== undefined) updates.spam = body.spam;
		if (body.spam === true) updates.trashed = false;
		demoStore.updateThread(params.id!, updates);
		return json({ ok: true });
	}

	if (!db) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	let organized = false;
	if (isConversationAction(body.action)) {
		try {
			const affected = await applyConversationAction(
				db,
				locals.user.id,
				[params.id!],
				body.action,
				{
					until: body.until,
					category: body.category,
					labelId: body.labelId,
					address: body.address
				}
			);
			if (affected === 0) {
				return json({ error: 'Not found' }, { status: 404 });
			}
			organized = true;
		} catch (error) {
			if (error instanceof OrganizingActionError) {
				return json({ error: error.message }, { status: 400 });
			}
			throw error;
		}
	}

	const ids = body.messageOnly
		? [params.id!]
		: await expandToThreads(db, locals.user.id, [params.id!]);

	const changed = await setEmailFlags(db, locals.user.id, ids, {
		isRead: body.isRead,
		isStarred: body.isStarred,
		trashed: body.trashed,
		spam: body.spam
	});

	if (!organized && changed === 0) {
		return json({ error: 'Not found' }, { status: 404 });
	}

	return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ params, locals, platform, url }) => {
	const db = platform?.env.DB;
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	// Demo mode: no-op (don't actually delete)
	// Demo mode is server-env only (DEMO_MODE="true"), never a URL param.
	const isDemoMode = DEMO_MODE;

	if (isDemoMode && locals.user.id === DEMO_USER.id) {
		return json({ ok: true });
	}

	if (!db) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const ids = await expandToThreads(db, locals.user.id, [params.id!]);
	const removed = await deleteEmailsPermanently(db, platform?.env.ATTACHMENTS, locals.user.id, ids);

	if (removed === 0) {
		return json({ error: 'Not found' }, { status: 404 });
	}

	return json({ ok: true });
};

export const POST: RequestHandler = async ({ params, request, locals, platform }) => {
	const db = platform?.env.DB;
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const body = (await request.json()) as ReplyBody;
	if (!body.text?.trim() && !body.html?.trim()) {
		return json({ error: 'Message body is required' }, { status: 400 });
	}
	if (body.mode !== undefined && !isComposeMode(body.mode)) {
		return json({ error: 'mode' }, { status: 400 });
	}
	const mode: ComposeMode = body.mode ?? 'reply';

	// Demo mode: fake reply. Hooks already reject this POST; the shape matches a real queue.
	// Demo mode is server-env only (DEMO_MODE="true"), never a URL param.
	const isDemoMode = DEMO_MODE;

	if (isDemoMode && locals.user.id === DEMO_USER.id) {
		const fakeId = `demo-reply-${Date.now()}`;
		return json({ id: fakeId, sendAt: holdUntil(new Date(), 10) });
	}

	if (!db) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const original = await getEmailForUser(db, locals.user.id, params.id!);
	if (!original) {
		return json({ error: 'Not found' }, { status: 404 });
	}

	// Reply from the address the message was received at (exact row, else catch-all).
	// Considers the whole conversation: when the newest message is our own
	// earlier reply, the default still follows where the last inbound arrived.
	const thread = await listThreadMessages(db, locals.user.id, original);
	const { preferred } = matchThreadReplyFrom(
		thread.length ? thread : [original],
		locals.addresses,
		locals.domains,
		locals.user.id
	);
	const receivedAt = threadReceivedAtAddresses(thread.length ? thread : [original]);
	const fromAddress = body.fromAddress ?? preferred?.address;

	let to = body.to?.trim() ?? '';
	const cc = body.cc;
	if (!to && (mode === 'reply' || mode === 'reply-all')) {
		const own = [
			...locals.addresses.map((address) => address.address),
			...(fromAddress ? [fromAddress] : [])
		];
		const stored = original as EmailRow & { reply_to_header?: string | null };
		const sets = replyRecipients({
			direction: original.direction,
			from: original.from_addr,
			replyTo: stored.reply_to_header ?? null,
			to: original.to_addr,
			cc: original.cc_addr,
			bcc: original.bcc_addr,
			own
		});
		to = (mode === 'reply-all' ? sets.replyAll : sets.reply).join(', ');
	}
	if (!to) {
		return json({ error: 'At least one valid recipient is required' }, { status: 400 });
	}

	const subject =
		body.subject?.trim() ||
		(mode === 'forward'
			? forwardSubject(original.subject)
			: mode === 'new'
				? ''
				: replySubject(original.subject));
	if (!subject) {
		return json({ error: 'To, subject, and message are required' }, { status: 400 });
	}

	const explicitSendAt = body.sendAt?.trim() ?? '';
	if (explicitSendAt) {
		const message = scheduleError(explicitSendAt, new Date());
		if (message) return json({ error: message }, { status: 400 });
	}

	try {
		await resolveFromAddress(
			db,
			locals.user,
			body.fromAddressId ?? preferred?.addressId,
			fromAddress,
			receivedAt
		);
	} catch (error) {
		const message = error instanceof Error && error.message ? error.message : 'Failed to send reply';
		return json({ error: message }, { status: 400 });
	}

	let undoInbox = false;
	if (body.archive === true && mode !== 'new' && !explicitSendAt) {
		try {
			await setThreadColumns(db, locals.user.id, [original.id], { in_inbox: 0 });
		} catch (error) {
			const message =
				error instanceof Error && error.message ? error.message : 'Could not archive the conversation';
			return json({ error: message }, { status: 400 });
		}
		undoInbox = true;
	}

	const threaded = mode === 'reply' || mode === 'reply-all';
	try {
		const queued = await queueOutbound(db, locals.user, {
			fromAddressId: body.fromAddressId ?? preferred?.addressId,
			fromAddress,
			receivedAt,
			to,
			cc,
			bcc: body.bcc,
			subject,
			text: body.text,
			html: body.html,
			sendAt: body.sendAt,
			inReplyTo: threaded ? original.message_id : null,
			references: threaded
				? buildReferences(original.references_header, original.message_id)
				: null,
			replyToEmailId: threaded ? original.id : null,
			sourceEmailId: mode === 'new' ? null : original.id,
			draftAction: mode === 'new' ? null : mode,
			undoInbox,
			threadId: threaded ? (original.thread_id ?? original.id) : null
		});

		return json({ id: queued.id, sendAt: queued.sendAt });
	} catch (error) {
		const message = error instanceof Error && error.message ? error.message : 'Failed to send reply';
		return json({ error: message }, { status: 400 });
	}
};
