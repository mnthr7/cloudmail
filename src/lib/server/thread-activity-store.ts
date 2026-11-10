import type { D1Database } from '@cloudflare/workers-types';
import type { ActivityState, ThreadActivity, ThreadActivityItem } from '#lib/agents/activity.ts';

export type { ThreadActivity } from '#lib/agents/activity.ts';

/**
 * What agents did on a thread, private notes, and take-over
 * (docs/specs/agent-staff-platform.md, A12, A13). Everything here belongs to
 * one mailbox: only its owner sees it.
 */

export async function addThreadNote(
	db: D1Database,
	input: {
		workspaceId: string;
		mailboxUserId: string;
		threadId: string;
		authorId: string | null;
		kind: 'note' | 'alert';
		body: string;
		actionId?: string | null;
		now?: Date;
	}
): Promise<string> {
	const id = crypto.randomUUID();
	await db
		.prepare(
			`INSERT INTO thread_notes (id, workspace_id, mailbox_user_id, thread_id, author_principal_id, kind, body, action_id, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			id,
			input.workspaceId,
			input.mailboxUserId,
			input.threadId,
			input.authorId,
			input.kind,
			input.body.slice(0, 10_000),
			input.actionId ?? null,
			(input.now ?? new Date()).toISOString()
		)
		.run();
	return id;
}

export async function isThreadTakenOver(db: D1Database, userId: string, threadId: string): Promise<boolean> {
	const row = await db
		.prepare(`SELECT 1 AS yes FROM thread_takeovers WHERE mailbox_user_id = ? AND thread_id = ?`)
		.bind(userId, threadId)
		.first<{ yes: number }>();
	return !!row;
}

/**
 * The owner takes the thread over: agents stop acting on it, and proposals
 * still waiting for approval on it expire. Asking an agent still works, since
 * that is the owner's own instruction.
 */
export async function takeOverThread(db: D1Database, userId: string, threadId: string, now = new Date()): Promise<void> {
	const at = now.toISOString();
	await db.batch([
		db
			.prepare(
				`INSERT OR IGNORE INTO thread_takeovers (mailbox_user_id, thread_id, by_principal_id, created_at)
				 VALUES (?, ?, (SELECT id FROM principals WHERE user_id = ? AND kind = 'human'), ?)`
			)
			.bind(userId, threadId, userId, at),
		db
			.prepare(
				`UPDATE agent_actions SET status = 'expired', decided_at = ?, decision_note = 'thread_taken_over'
				 WHERE mailbox_user_id = ? AND thread_id = ? AND status = 'queued'`
			)
			.bind(at, userId, threadId)
	]);
}

/** Hands the thread back: agents may act on it again. */
export async function handBackThread(db: D1Database, userId: string, threadId: string): Promise<void> {
	await db
		.prepare(`DELETE FROM thread_takeovers WHERE mailbox_user_id = ? AND thread_id = ?`)
		.bind(userId, threadId)
		.run();
}

type ActionRow = {
	id: string;
	capability: string;
	status: string;
	reason: string;
	payload_json: string;
	policy_reason: string;
	exec_error: string | null;
	decision_note: string | null;
	created_at: string;
	decided_at: string | null;
	executed_at: string | null;
	agent_name: string;
	decided_by: string | null;
	trigger_kind: 'mail' | 'ask' | null;
};

function describeAction(capability: string, payload: Record<string, unknown>): string {
	switch (capability) {
		case 'send_reply': {
			const to = Array.isArray(payload.to) ? payload.to.join(', ') : '';
			return to ? `Reply to ${to}` : 'Send a reply';
		}
		case 'draft_reply':
			return 'Draft a reply';
		case 'write_note':
			return 'Leave a note';
		case 'organize':
			switch (payload.action) {
				case 'archive':
					return 'Archive';
				case 'star':
					return 'Star';
				case 'mark_read':
					return 'Mark as read';
				case 'mark_important':
					return 'Mark as important';
				case 'add_label':
					return `Label "${typeof payload.label === 'string' ? payload.label : ''}"`;
			}
			return 'Organize';
		default:
			return capability;
	}
}

function stateOf(row: ActionRow): ActivityState {
	if (row.status === 'executed') return 'done';
	if (row.exec_error?.startsWith('loop_')) return 'stopped';
	if (row.exec_error) return 'failed';
	switch (row.status) {
		case 'queued':
			return 'waiting';
		case 'shadowed':
			return 'shadow';
		case 'declined':
			return 'declined';
		case 'expired':
			return 'expired';
		case 'rejected':
			return 'refused';
		default:
			// approved or auto_approved, not carried out yet
			return 'waiting';
	}
}

/** Everything agents did, proposed, or noted on a thread, oldest first. */
export async function threadActivity(db: D1Database, userId: string, threadId: string): Promise<ThreadActivity> {
	const [actions, notes, takeover] = await Promise.all([
		db
			.prepare(
				`SELECT x.id, x.capability, x.status, x.reason, x.payload_json, x.policy_reason, x.exec_error,
				        x.decision_note, x.created_at, x.decided_at, x.executed_at,
				        p.display_name AS agent_name, d.display_name AS decided_by, r.trigger_kind
				 FROM agent_actions x
				 JOIN principals p ON p.id = x.agent_principal_id
				 LEFT JOIN principals d ON d.id = x.decided_by_principal_id
				 LEFT JOIN agent_runs r ON r.id = x.run_id
				 WHERE x.mailbox_user_id = ? AND x.thread_id = ?
				 ORDER BY x.created_at ASC
				 LIMIT 100`
			)
			.bind(userId, threadId)
			.all<ActionRow>(),
		db
			.prepare(
				`SELECT n.id, n.kind, n.body, n.created_at, p.display_name AS agent_name, p.kind AS author_kind
				 FROM thread_notes n LEFT JOIN principals p ON p.id = n.author_principal_id
				 WHERE n.mailbox_user_id = ? AND n.thread_id = ?
				 ORDER BY n.created_at ASC
				 LIMIT 100`
			)
			.bind(userId, threadId)
			.all<{
				id: string;
				kind: 'note' | 'alert';
				body: string;
				created_at: string;
				agent_name: string | null;
				author_kind: string | null;
			}>(),
		db
			.prepare(
				`SELECT t.created_at, p.display_name AS by_name
				 FROM thread_takeovers t LEFT JOIN principals p ON p.id = t.by_principal_id
				 WHERE t.mailbox_user_id = ? AND t.thread_id = ?`
			)
			.bind(userId, threadId)
			.first<{ created_at: string; by_name: string | null }>()
	]);

	const items: ThreadActivityItem[] = [];
	for (const row of actions.results) {
		let payload: Record<string, unknown> = {};
		try {
			payload = JSON.parse(row.payload_json) as Record<string, unknown>;
		} catch {
			// shown without detail
		}
		const state = stateOf(row);
		// A note an agent wrote shows as the note itself, not also as the action that made it.
		if (row.capability === 'write_note' && state === 'done') continue;
		items.push({
			kind: 'action',
			id: row.id,
			agentName: row.agent_name,
			capability: row.capability,
			what: describeAction(row.capability, payload),
			state,
			reason: row.reason,
			trigger: row.trigger_kind,
			decidedBy: row.decided_by,
			detail:
				state === 'refused'
					? row.policy_reason
					: state === 'failed' || state === 'stopped'
						? row.exec_error
						: state === 'expired'
							? row.decision_note
							: null,
			at: row.executed_at ?? row.decided_at ?? row.created_at
		});
	}
	for (const note of notes.results) {
		items.push({
			kind: note.kind,
			id: note.id,
			agentName: note.agent_name,
			byHuman: note.author_kind === 'human',
			body: note.body,
			at: note.created_at
		});
	}
	if (takeover) items.push({ kind: 'takeover', by: takeover.by_name, at: takeover.created_at });
	items.sort((a, b) => a.at.localeCompare(b.at));
	return { items, takenOver: !!takeover };
}
