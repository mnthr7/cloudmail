import type { D1Database } from '@cloudflare/workers-types';
import type { MailAddress } from '#lib/types.ts';
import { scheduleError } from '../writing/timing';
import { initialOutboundStatus, type EmailProvider } from './email-provider';
import { setThreadColumns } from './organizing-store';
import { sendOutboundEmail } from './send-mail';

export type ScheduledMailInsert = {
	userId: string;
	/** A hold may be under a minute. A schedule is rejected until it is a minute ahead. */
	kind: 'hold' | 'schedule';
	sendAt: string;
	from: string;
	to: string;
	cc?: string | null;
	bcc?: string | null;
	subject: string;
	text?: string | null;
	html?: string | null;
	inReplyTo?: string | null;
	references?: string | null;
	replyToEmailId?: string | null;
	sourceEmailId?: string | null;
	draftAction?: 'reply' | 'reply-all' | 'forward' | null;
	/** Set when the caller already archived the source conversation. */
	undoInbox?: boolean;
	domainId?: string | null;
	threadId?: string | null;
};

type DueRow = {
	id: string;
	user_id: string;
};

type OutboundRow = {
	from_addr: string;
	to_addr: string;
	cc_addr: string | null;
	bcc_addr: string | null;
	subject: string;
	body_text: string | null;
	body_html: string | null;
	in_reply_to: string | null;
	references_header: string | null;
	domain_id: string | null;
};

/**
 * Stores an outbound row as scheduled. Archive is the caller's job: this
 * inserts nothing until it is called, and it does not change the source thread.
 */
export async function insertScheduled(db: D1Database, row: ScheduledMailInsert): Promise<string> {
	if (row.kind === 'schedule') {
		const message = scheduleError(row.sendAt, new Date());
		if (message) throw new Error(message);
	}

	const id = crypto.randomUUID();
	await db
		.prepare(
			`INSERT INTO emails (
				id, user_id, direction, from_addr, to_addr, cc_addr, bcc_addr,
				subject, body_text, body_html, in_reply_to, references_header,
				reply_to_email_id, thread_id, domain_id, status, send_at,
				undo_inbox, source_email_id, draft_action
			) VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?)`
		)
		.bind(
			id,
			row.userId,
			row.from,
			row.to,
			row.cc ?? null,
			row.bcc ?? null,
			row.subject,
			row.text ?? null,
			row.html ?? null,
			row.inReplyTo ?? null,
			row.references ?? null,
			row.replyToEmailId ?? null,
			row.threadId ?? null,
			row.domainId ?? null,
			row.sendAt,
			row.undoInbox ? 1 : 0,
			row.sourceEmailId ?? null,
			row.draftAction ?? null
		)
		.run();

	return id;
}

/**
 * One update wins. Status leaves `scheduled` before the provider is called,
 * so a crash here cannot send the same row again.
 */
export async function claimScheduled(
	db: D1Database,
	id: string,
	userId: string,
	now: Date,
	provider: Pick<EmailProvider, 'kind'>
): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE emails
				 SET status = ?
			 WHERE id = ? AND user_id = ? AND status = 'scheduled' AND datetime(send_at) <= datetime(?)`
		)
		.bind(initialOutboundStatus(provider.kind), id, userId, now.toISOString())
		.run();

	return result.meta.changes === 1;
}

/** Undo and cancel. A row that is no longer scheduled was already claimed. */
export async function undoScheduled(
	db: D1Database,
	id: string,
	userId: string
): Promise<'draft' | 'sent'> {
	const result = await db
		.prepare(
			`UPDATE emails
				 SET status = 'draft', send_at = NULL
			 WHERE id = ? AND user_id = ? AND status = 'scheduled'`
		)
		.bind(id, userId)
		.run();

	if (result.meta.changes !== 1) return 'sent';

	const draft = await db
		.prepare('SELECT undo_inbox, source_email_id FROM emails WHERE id = ? AND user_id = ?')
		.bind(id, userId)
		.first<{ undo_inbox: number; source_email_id: string | null }>();

	if (draft?.undo_inbox === 1 && draft.source_email_id) {
		await setThreadColumns(db, userId, [draft.source_email_id], {
			in_inbox: 1,
			snoozed_until: null
		});
	}

	return 'draft';
}

/**
 * Claims each due scheduled row, then sends it. A claimed or failed row is
 * not scheduled, so a later run does not select it.
 */
export async function deliverDue(
	db: D1Database,
	provider: EmailProvider,
	now: Date,
	limit = 20
): Promise<number> {
	const { results } = await db
		.prepare(
			`SELECT id, user_id
			   FROM emails
			  WHERE status = 'scheduled' AND datetime(send_at) <= datetime(?)
			  ORDER BY datetime(send_at) ASC, id ASC
			  LIMIT ?`
		)
		.bind(now.toISOString(), limit)
		.all<DueRow>();

	let delivered = 0;
	for (const due of results) {
		const claimed = await claimScheduled(db, due.id, due.user_id, now, provider);
		if (!claimed) continue;

		let result: { providerId: string };
		try {
			result = await sendOutboundEmail(provider, await outboundInput(db, due));
		} catch (error) {
			const message = error instanceof Error && error.message ? error.message : 'Send failed';
			await db
				.prepare(
					`UPDATE emails SET status = 'failed', status_detail = ?
					 WHERE id = ? AND user_id = ?`
				)
				.bind(message, due.id, due.user_id)
				.run();
			continue;
		}

		await db
			.prepare('UPDATE emails SET provider_id = ? WHERE id = ? AND user_id = ?')
			.bind(result.providerId, due.id, due.user_id)
			.run();
		delivered += 1;
	}

	return delivered;
}

/** The claimed row, shaped for `sendOutboundEmail`. No attachment bytes. */
export async function loadScheduledOutbound(db: D1Database, due: DueRow) {
	return outboundInput(db, due);
}

async function outboundInput(db: D1Database, due: DueRow) {
	const stored = await db
		.prepare(
			`SELECT from_addr, to_addr, cc_addr, bcc_addr, subject, body_text, body_html,
			        in_reply_to, references_header, domain_id
			   FROM emails
			  WHERE id = ? AND user_id = ?`
		)
		.bind(due.id, due.user_id)
		.first<OutboundRow>();

	if (!stored) {
		throw new Error('Scheduled message disappeared after it was claimed');
	}

	const user = await db
		.prepare('SELECT name FROM users WHERE id = ?')
		.bind(due.user_id)
		.first<{ name: string }>();

	return {
		from: mailAddress(due.user_id, stored.from_addr, stored.domain_id),
		senderName: user?.name?.trim() || stored.from_addr,
		to: stored.to_addr,
		cc: stored.cc_addr ?? undefined,
		bcc: stored.bcc_addr ?? undefined,
		subject: stored.subject,
		text: stored.body_text ?? '',
		html: stored.body_html ?? undefined,
		inReplyTo: stored.in_reply_to,
		references: stored.references_header,
		idempotencyKey: due.id
	};
}

function mailAddress(userId: string, address: string, domainId: string | null): MailAddress {
	return {
		id: domainId ? `${domainId}:${address}` : address,
		user_id: userId,
		domain_id: domainId ?? '',
		domain_name: address.split('@')[1] ?? '',
		address,
		label: null,
		is_default: false,
		created_at: new Date(0).toISOString()
	};
}
