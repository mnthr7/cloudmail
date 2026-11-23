import type { D1Database } from '@cloudflare/workers-types';

/**
 * Events for external agents (docs/specs/external-agents.md, X4): IDs only.
 * check_new_mail pages through them, and webhooks deliver the same rows. Kept
 * apart from the stores so any of them can record one without import cycles.
 */

export type AgentEventType = 'message.received' | 'action.decided' | 'mention.created' | 'timer.fired';

export type AgentEvent = {
	seq: number;
	type: AgentEventType;
	threadId: string | null;
	emailId: string | null;
	actionId: string | null;
	timerId: string | null;
	createdAt: string;
};

/**
 * Records an event for an external agent, and a pending webhook delivery for
 * each of its live connections that has a webhook URL. Returns the event seq.
 */
export async function emitEvent(
	db: D1Database,
	input: {
		agentId: string;
		type: AgentEventType;
		threadId?: string | null;
		emailId?: string | null;
		actionId?: string | null;
		timerId?: string | null;
	},
	now = new Date()
): Promise<number> {
	const stamp = now.toISOString();
	const row = await db
		.prepare(
			`INSERT INTO agent_events (agent_principal_id, type, thread_id, email_id, action_id, timer_id, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 RETURNING seq`
		)
		.bind(
			input.agentId,
			input.type,
			input.threadId ?? null,
			input.emailId ?? null,
			input.actionId ?? null,
			input.timerId ?? null,
			stamp
		)
		.first<{ seq: number }>();
	if (!row) throw new Error('Failed to record the event');
	await db
		.prepare(
			`INSERT OR IGNORE INTO webhook_deliveries (id, connection_id, event_seq, attempt, status, next_retry_at, created_at)
			 SELECT 'wd_' || lower(hex(randomblob(16))), id, ?, 0, 'pending', ?, ?
			 FROM agent_connections
			 WHERE agent_principal_id = ? AND status = 'active' AND webhook_url IS NOT NULL`
		)
		.bind(row.seq, stamp, stamp, input.agentId)
		.run();
	return row.seq;
}
