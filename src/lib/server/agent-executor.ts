import type { D1Database } from '@cloudflare/workers-types';
import { looksLikeAutoReply } from '#lib/agents/auto-reply.ts';
import { LABEL_COLORS } from '#lib/organizing/labels.ts';
import { threadReceivedAtAddresses } from '#lib/reply-from.ts';
import { textToHtml } from '#lib/agents/suggestions.ts';
import { replyRecipients } from '#lib/writing/recipients.ts';
import { authorize, type AuthorizedAddresses } from '#lib/agents/policy.ts';
import { threadParticipants } from './agent-brain.ts';
import { getAgent, liveWorkspaceAddresses, sendableForAuthor } from './agents-store.ts';
import { getUserById } from './auth.ts';
import { createLabel, listLabels } from './labels-store.ts';
import { addMemory, MemoryError } from './agent-memory-store.ts';
import {
	expandToThreads,
	getEmailForUser,
	listThreadMessages,
	saveDraft,
	setEmailFlags
} from './mail-store.ts';
import { applyConversationAction } from './organizing-store.ts';
import { resolveFromAddress } from './outbox.ts';
import { queueOutbound } from './queue-outbound.ts';
import { buildReferences } from './threads.ts';
import { addThreadNote, isThreadTakenOver } from './thread-activity-store.ts';

/**
 * Carries out agent actions that the policy engine or a human allowed
 * (docs/specs/agent-staff-platform.md, A6, A12–A14). Each action runs at most
 * once: it is claimed first, and a failure is recorded rather than retried.
 * Mail an agent sends goes through the same undo hold as the founder's own,
 * from the exact addresses the policy authorized, with an AI disclosure.
 */

/** Sends by any agent to one person in 24 hours before the guard stops them. */
export const MAX_SENDS_PER_RECIPIENT_PER_DAY = 3;
/** Agent messages on one thread with no human reply before the guard stops them. */
export const MAX_AGENT_MESSAGES_WITHOUT_HUMAN = 6;
/** A claim older than this was cut off, so the action can be tried again. */
const STALE_CLAIM_MS = 10 * 60 * 1000;

const SEND_CAPABILITIES = new Set(['send_reply', 'send_email']);

export type ExecuteResult =
	| { status: 'executed'; ref: string | null }
	/** A loop guard stopped it, and the founder was told on the thread. */
	| { status: 'blocked'; error: string }
	| { status: 'failed'; error: string }
	/** Not runnable: already done, already claimed, or never allowed. */
	| { status: 'skipped' };

type ClaimedAction = {
	id: string;
	workspace_id: string;
	agent_principal_id: string;
	/** approved (a human said yes) or auto_approved (the policy did). */
	status: string;
	capability: string;
	thread_id: string | null;
	payload_json: string;
	authorized_json: string | null;
	mailbox_user_id: string | null;
	decided_by_principal_id: string | null;
	agent_name: string;
	agent_status: string;
	/** What woke the agent up: 'ask' means the owner asked for this. */
	trigger_kind: string | null;
};

class StopError extends Error {
	constructor(
		readonly code: string,
		readonly blocked = false
	) {
		super(code);
		this.name = 'StopError';
	}
}

/** The footer every agent-sent email carries (A12). */
export function disclosureFooter(agentName: string, founderName: string): string {
	return `—\n${agentName} is an AI assistant working with ${founderName}.`;
}

export async function executeAction(db: D1Database, actionId: string, now = new Date()): Promise<ExecuteResult> {
	const at = now.toISOString();
	const claim = await db
		.prepare(
			`UPDATE agent_actions SET exec_claimed_at = ?
			 WHERE id = ? AND status IN ('approved', 'auto_approved') AND executed_at IS NULL AND exec_error IS NULL
			   AND (exec_claimed_at IS NULL OR exec_claimed_at < ?)`
		)
		.bind(at, actionId, new Date(now.getTime() - STALE_CLAIM_MS).toISOString())
		.run();
	if (!claim.meta.changes) return { status: 'skipped' };

	const action = await db
		.prepare(
			`SELECT x.id, x.workspace_id, x.agent_principal_id, x.status, x.capability, x.thread_id, x.payload_json,
			        x.authorized_json, x.mailbox_user_id, x.decided_by_principal_id,
			        p.display_name AS agent_name, a.status AS agent_status, r.trigger_kind
			 FROM agent_actions x
			 JOIN principals p ON p.id = x.agent_principal_id
			 JOIN agents a ON a.principal_id = x.agent_principal_id
			 LEFT JOIN agent_runs r ON r.id = x.run_id
			 WHERE x.id = ?`
		)
		.bind(actionId)
		.first<ClaimedAction>();
	if (!action) return { status: 'skipped' };

	try {
		const ref = await carryOut(db, action, now);
		await db
			.prepare(
				`UPDATE agent_actions SET status = 'executed', executed_at = ?, result_ref = ?, exec_claimed_at = NULL
				 WHERE id = ?`
			)
			.bind(now.toISOString(), ref, action.id)
			.run();
		return { status: 'executed', ref };
	} catch (error) {
		const stop = error instanceof StopError ? error : null;
		const message = (stop?.code ?? (error instanceof Error ? error.message : 'error')).slice(0, 300);
		await db
			.prepare(`UPDATE agent_actions SET exec_error = ?, exec_claimed_at = NULL WHERE id = ?`)
			.bind(message, action.id)
			.run();
		if (stop?.blocked && action.mailbox_user_id && action.thread_id) {
			await addThreadNote(db, {
				workspaceId: action.workspace_id,
				mailboxUserId: action.mailbox_user_id,
				threadId: action.thread_id,
				authorId: action.agent_principal_id,
				kind: 'alert',
				body: guardMessage(action.agent_name, stop.code),
				actionId: action.id,
				now
			});
		}
		if (!stop) console.error('Agent action failed', action.id, action.capability, message);
		return stop?.blocked ? { status: 'blocked', error: message } : { status: 'failed', error: message };
	}
}

function guardMessage(agent: string, code: string): string {
	switch (code) {
		case 'loop_auto_reply':
			return `${agent} stopped: the last message looks like an automatic reply, so answering it could start a loop. Reply yourself if it needs one.`;
		case 'loop_recipient_flood':
			return `${agent} stopped: agents already wrote to this person ${MAX_SENDS_PER_RECIPIENT_PER_DAY} times in the last day. Check the thread before anything else goes out.`;
		case 'loop_thread_runaway':
			return `${agent} stopped: agents sent ${MAX_AGENT_MESSAGES_WITHOUT_HUMAN} messages on this thread without anyone from your side replying. Take a look before it continues.`;
		default:
			return `${agent} stopped (${code}).`;
	}
}

async function carryOut(db: D1Database, action: ClaimedAction, now: Date): Promise<string | null> {
	// Pausing takes effect for actions in flight (A10). recheckPolicy repeats this with the full definition.
	if (action.agent_status === 'paused') throw new StopError('agent_paused');
	if (!action.mailbox_user_id || !action.thread_id) throw new StopError('no_thread');

	// After a take-over only what a human approved or asked for still happens (A13).
	const humanSaidSo = !!action.decided_by_principal_id || action.trigger_kind === 'ask';
	if (!humanSaidSo && (await isThreadTakenOver(db, action.mailbox_user_id, action.thread_id))) {
		throw new StopError('thread_taken_over');
	}

	const user = await getUserById(db, action.mailbox_user_id);
	if (!user) throw new StopError('mailbox_gone');
	const payload = JSON.parse(action.payload_json) as Record<string, unknown>;
	const emailId = typeof payload.emailId === 'string' ? payload.emailId : '';
	const email = emailId ? await getEmailForUser(db, user.id, emailId) : null;
	if (!email || email.deleted_at) throw new StopError('email_gone');
	const threadId = email.thread_id ?? email.id;
	if (threadId !== action.thread_id) throw new StopError('email_gone');
	const thread = await listThreadMessages(db, user.id, email);
	await recheckPolicy(db, action, thread.length ? thread : [email]);

	switch (action.capability) {
		case 'write_note': {
			const note = typeof payload.note === 'string' ? payload.note.trim() : '';
			if (!note) throw new StopError('empty');
			return addThreadNote(db, {
				workspaceId: action.workspace_id,
				mailboxUserId: user.id,
				threadId,
				authorId: action.agent_principal_id,
				kind: 'note',
				body: note,
				actionId: action.id,
				now
			});
		}

		case 'organize': {
			const ids = await expandToThreads(db, user.id, [email.id]);
			switch (payload.action) {
				case 'archive':
					await applyConversationAction(db, user.id, ids, 'archive', {});
					return null;
				case 'mark_important':
					await applyConversationAction(db, user.id, ids, 'important', {});
					return null;
				case 'star':
					await setEmailFlags(db, user.id, [email.id], { isStarred: true });
					return null;
				case 'mark_read':
					await setEmailFlags(db, user.id, ids, { isRead: true });
					return null;
				case 'add_label': {
					const name = typeof payload.label === 'string' ? payload.label.trim() : '';
					if (!name) throw new StopError('empty');
					const labels = await listLabels(db, user.id);
					const label =
						labels.find((item) => item.name.toLowerCase() === name.toLowerCase()) ??
						(await createLabel(db, user.id, { name, parentId: null, color: LABEL_COLORS[0] }));
					await applyConversationAction(db, user.id, ids, 'label', { labelId: label.id });
					return label.id;
				}
				default:
					throw new StopError('unknown_organize_action');
			}
		}

		case 'draft_reply': {
			const body = typeof payload.body === 'string' ? payload.body.trim() : '';
			if (!body) throw new StopError('empty');
			const receivedAt = threadReceivedAtAddresses(thread.length ? thread : [email]);
			let from;
			try {
				from = await resolveFromAddress(db, user, null, receivedAt[0] ?? null, receivedAt);
			} catch {
				from = await resolveFromAddress(db, user, null, null);
			}
			const own = await ownAddresses(db, user.id);
			const stored = email as typeof email & { reply_to_header?: string | null };
			const to = replyRecipients({
				direction: email.direction,
				from: email.from_addr,
				replyTo: stored.reply_to_header ?? null,
				to: email.to_addr,
				cc: email.cc_addr,
				bcc: email.bcc_addr,
				own: [...own, from.address]
			}).reply;
			return saveDraft(db, user.id, {
				from: from.address,
				to: to.join(', '),
				subject: typeof payload.subject === 'string' ? payload.subject : email.subject,
				bodyText: body,
				bodyHtml: textToHtml(body),
				domainId: from.domain_id,
				sourceEmailId: email.id,
				draftAction: 'reply'
			});
		}

		case 'send_reply': {
			const body = typeof payload.body === 'string' ? payload.body.trim() : '';
			if (!body) throw new StopError('empty');
			const authorized = action.authorized_json
				? (JSON.parse(action.authorized_json) as AuthorizedAddresses)
				: null;
			if (!authorized?.from || authorized.recipients.length === 0) throw new StopError('not_authorized');
			// Only addresses the policy checked go out, split back into To and Cc.
			const allowed = new Set(authorized.recipients);
			const pick = (value: unknown) =>
				(Array.isArray(value) ? value : [])
					.filter((item): item is string => typeof item === 'string')
					.map((item) => item.trim().toLowerCase())
					.filter((item, index, all) => allowed.has(item) && all.indexOf(item) === index);
			const to = pick(payload.to);
			const cc = pick(payload.cc).filter((address) => !to.includes(address));
			if (to.length === 0) throw new StopError('not_authorized');

			await loopGuard(db, action, [...to, ...cc], thread.length ? thread : [email], now);

			const text = `${body}\n\n${disclosureFooter(action.agent_name, user.name)}`;
			const queued = await queueOutbound(db, user, {
				fromAddress: authorized.from,
				receivedAt: threadReceivedAtAddresses(thread.length ? thread : [email]),
				to: to.join(', '),
				cc: cc.join(', ') || null,
				subject: typeof payload.subject === 'string' ? payload.subject : email.subject,
				text,
				html: textToHtml(text),
				inReplyTo: email.message_id,
				references: buildReferences(email.references_header, email.message_id),
				replyToEmailId: email.id,
				sourceEmailId: email.id,
				draftAction: 'reply',
				threadId
			});
			return queued.id;
		}

		case 'propose_memory': {
			// Only ever after a human said yes (the policy never lets it run on its own).
			if (!action.decided_by_principal_id) throw new StopError('needs_approval');
			try {
				const added = await addMemory(
					db,
					{
						agentId: action.agent_principal_id,
						fact: payload.fact,
						source: 'agent',
						byPrincipalId: action.decided_by_principal_id,
						actionId: action.id
					},
					now
				);
				return added.id;
			} catch (error) {
				if (error instanceof MemoryError) throw new StopError(error.code === 'full' ? 'memory_full' : 'empty');
				throw error;
			}
		}

		default:
			throw new StopError('not_supported');
	}
}

/**
 * The decision was made earlier: when it was proposed, or when a human
 * approved it. Before anything happens it is made again against the agent as
 * it is now, so pausing it, putting it back in shadow mode, turning a
 * capability down, or narrowing what it may send from or to stops it at once.
 */
async function recheckPolicy(
	db: D1Database,
	action: ClaimedAction,
	thread: Parameters<typeof threadParticipants>[0]
): Promise<void> {
	const agent = await getAgent(db, action.agent_principal_id);
	if (!agent) throw new StopError('agent_gone');
	if (agent.status === 'paused') throw new StopError('agent_paused');
	if (agent.status !== 'active') throw new StopError('agent_in_shadow');

	const authorized = action.authorized_json ? (JSON.parse(action.authorized_json) as AuthorizedAddresses) : null;
	const addresses = await liveWorkspaceAddresses(db, agent.workspaceId);
	const decision = authorize(
		{
			capability: action.capability,
			fromAddress: authorized?.from ?? undefined,
			recipients: authorized?.recipients ?? []
		},
		{
			status: agent.status,
			runtime: agent.runtime,
			definition: agent.version.definition,
			threadParticipants: threadParticipants(thread),
			founderAddresses: [...addresses.keys()],
			sendableAddresses: await sendableForAuthor(db, agent.workspaceId, addresses, agent.version.createdByPrincipalId),
			// The daily limit was counted when it was proposed; take-over is checked separately.
			usedToday: 0,
			humanApprovals: Number.MAX_SAFE_INTEGER
		}
	);
	if (decision.outcome === 'reject') throw new StopError(decision.reason);
	// What the policy allowed on its own must still be allowed on its own.
	if (action.status === 'auto_approved' && decision.outcome !== 'execute') throw new StopError('needs_approval');
	if (decision.outcome === 'shadow') throw new StopError('agent_in_shadow');
}

async function ownAddresses(db: D1Database, userId: string): Promise<string[]> {
	const { results } = await db
		.prepare(`SELECT address FROM addresses WHERE user_id = ?`)
		.bind(userId)
		.all<{ address: string }>();
	return results.map((row) => row.address);
}

/**
 * Sent since a time, or being sent right now by another request. Every action
 * is claimed before this check runs, so two sends racing each other each count
 * the other, and the one that would go over the cap is stopped. Binds two times.
 */
const SENT_OR_SENDING = `((status = 'executed' AND executed_at > ?)
	OR (status IN ('approved', 'auto_approved') AND exec_error IS NULL AND exec_claimed_at > ?))`;

/**
 * Loop and runaway protection (A14), checked right before anything is sent:
 * never answer a machine, never write to one person too often, and never keep
 * a thread going on agents alone.
 */
async function loopGuard(
	db: D1Database,
	action: ClaimedAction,
	recipients: string[],
	thread: Array<{ direction: string; subject: string; created_at: string }>,
	now: Date
): Promise<void> {
	const lastInbound = [...thread].reverse().find((message) => message.direction === 'inbound');
	if (lastInbound && looksLikeAutoReply(lastInbound.subject)) throw new StopError('loop_auto_reply', true);

	const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
	for (const recipient of recipients) {
		const row = await db
			.prepare(
				`SELECT COUNT(*) AS n FROM agent_actions
				 WHERE workspace_id = ? AND capability IN ('send_reply', 'send_email') AND id <> ?
				   AND ${SENT_OR_SENDING}
				   AND EXISTS (SELECT 1 FROM json_each(authorized_json, '$.recipients') WHERE value = ?)`
			)
			.bind(action.workspace_id, action.id, dayAgo, dayAgo, recipient)
			.first<{ n: number }>();
		if ((row?.n ?? 0) >= MAX_SENDS_PER_RECIPIENT_PER_DAY) throw new StopError('loop_recipient_flood', true);
	}

	// Agent messages on this thread since someone on our side last wrote on it themselves.
	const lastHuman = await db
		.prepare(
			`SELECT MAX(e.created_at) AS at FROM emails e
			 WHERE e.user_id = ? AND e.thread_id = ? AND e.direction = 'outbound'
			   AND (e.status IS NULL OR e.status <> 'draft')
			   AND NOT EXISTS (SELECT 1 FROM agent_actions x WHERE x.result_ref = e.id)`
		)
		.bind(action.mailbox_user_id, action.thread_id)
		.first<{ at: string | null }>();
	const since = lastHuman?.at ?? '';
	const sent = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM agent_actions
			 WHERE mailbox_user_id = ? AND thread_id = ? AND id <> ?
			   AND capability IN ('send_reply', 'send_email') AND ${SENT_OR_SENDING}`
		)
		.bind(action.mailbox_user_id, action.thread_id, action.id, since, since)
		.first<{ n: number }>();
	if ((sent?.n ?? 0) >= MAX_AGENT_MESSAGES_WITHOUT_HUMAN) throw new StopError('loop_thread_runaway', true);
}

/** Whether an action's effect reaches outside the workspace. */
export function sendsMail(capability: string): boolean {
	return SEND_CAPABILITIES.has(capability);
}

/**
 * Picks up allowed actions that never finished: the request carrying one out
 * was cut off. Runs from the cron. Only recent ones, so nothing happens late.
 */
export async function executePending(db: D1Database, now = new Date(), limit = 10): Promise<number> {
	const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
	const { results } = await db
		.prepare(
			`SELECT id FROM agent_actions
			 WHERE status IN ('approved', 'auto_approved') AND executed_at IS NULL AND exec_error IS NULL
			   AND COALESCE(decided_at, created_at) >= ?
			   AND (exec_claimed_at IS NULL OR exec_claimed_at < ?)
			 ORDER BY created_at ASC LIMIT ?`
		)
		.bind(since, new Date(now.getTime() - STALE_CLAIM_MS).toISOString(), limit)
		.all<{ id: string }>();
	let done = 0;
	for (const row of results) {
		if ((await executeAction(db, row.id, now)).status === 'executed') done++;
	}
	return done;
}
