import type { D1Database } from '@cloudflare/workers-types';
import type { User } from '#lib/types.ts';
import { holdUntil } from '#lib/writing/timing.ts';
import { readUndoSendSeconds } from './auth';
import { stripHtml } from './html';
import { resolveFromAddress } from './outbox';
import { insertScheduled, type ScheduledMailInsert } from './outbox-schedule';
import { parseRecipients } from './send-mail';

export type QueueOutboundInput = {
	fromAddressId?: string | null;
	fromAddress?: string | null;
	receivedAt?: string[];
	to: string;
	cc?: string | null;
	bcc?: string | null;
	subject: string;
	text?: string | null;
	html?: string | null;
	/** Set for Schedule send. Absent means an undo hold. */
	sendAt?: string | null;
	inReplyTo?: string | null;
	references?: string | null;
	replyToEmailId?: string | null;
	sourceEmailId?: string | null;
	draftAction?: ScheduledMailInsert['draftAction'];
	undoInbox?: boolean;
	threadId?: string | null;
};

/**
 * Resolves From the same way an immediate send does, then stores a scheduled
 * row. Does not call the provider.
 */
export async function queueOutbound(
	db: D1Database,
	user: User,
	input: QueueOutboundInput
): Promise<{ id: string; sendAt: string }> {
	const from = await resolveFromAddress(
		db,
		user,
		input.fromAddressId,
		input.fromAddress,
		input.receivedAt
	);

	const explicit = input.sendAt?.trim() || null;
	const sendAt = explicit ?? holdUntil(new Date(), await readUndoSendSeconds(db, user.id));
	const html = input.html?.trim() || null;
	const text = input.text?.trim() || (html ? stripHtml(html) : '');
	const to = parseRecipients(input.to).join(', ');
	if (!to) {
		throw new Error('At least one valid recipient is required');
	}

	const id = await insertScheduled(db, {
		userId: user.id,
		kind: explicit ? 'schedule' : 'hold',
		sendAt,
		from: from.address,
		to,
		cc: parseRecipients(input.cc).join(', ') || null,
		bcc: parseRecipients(input.bcc).join(', ') || null,
		subject: input.subject.trim(),
		text,
		html: html ?? (text ? text.replaceAll('\n', '<br>\n') : null),
		inReplyTo: input.inReplyTo ?? null,
		references: input.references ?? null,
		replyToEmailId: input.replyToEmailId ?? null,
		sourceEmailId: input.sourceEmailId ?? null,
		draftAction: input.draftAction ?? null,
		undoInbox: input.undoInbox,
		domainId: from.domain_id,
		threadId: input.threadId ?? null
	});

	return { id, sendAt };
}
