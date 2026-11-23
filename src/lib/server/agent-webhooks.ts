import type { D1Database } from '@cloudflare/workers-types';
import { openSecret, sealSecret } from './secret-box.ts';
import { newWebhookSecret, signWebhook } from './webhook.ts';
import {
	emitEvent,
	getConnection,
	pauseForFailingWebhooks,
	webhookSecretFor,
	ConnectionNotAllowedError
} from './external-agents-store.ts';
import { getAgent, humanPrincipalForUser } from './agents-store.ts';

/**
 * Webhooks to external agents (docs/specs/external-agents.md, X4). Each event
 * is delivered to every live connection with a webhook URL, signed the
 * Standard Webhooks way, and retried with backoff for 24 hours. Payloads carry
 * IDs only: the agent reads content through get_thread, which checks scope again.
 */

/** Give up on an event this long after it happened, and mark the delivery dead. */
export const DELIVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const FIRST_RETRY_MS = 30_000;
const MAX_RETRY_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const CLAIM_MS = 2 * 60 * 1000;

export class WebhookUrlError extends Error {
	readonly status = 400;
	constructor(readonly code: 'not_https' | 'not_public' | 'invalid') {
		super(code);
		this.name = 'WebhookUrlError';
	}
}

/**
 * Only public HTTPS URLs. Workers can't reach a private network anyway, but a
 * literal loopback or private address is refused up front so nobody points a
 * webhook at something that only looks internal.
 */
export function checkWebhookUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new WebhookUrlError('invalid');
	}
	if (url.protocol !== 'https:') throw new WebhookUrlError('not_https');
	if (url.username || url.password) throw new WebhookUrlError('invalid');
	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
	const privateHost =
		host === 'localhost' ||
		host.endsWith('.localhost') ||
		host.endsWith('.internal') ||
		host.endsWith('.local') ||
		/^(127|10|0)\./.test(host) ||
		/^192\.168\./.test(host) ||
		/^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
		/^169\.254\./.test(host) ||
		host === '::1' ||
		/^f[cd][0-9a-f]{2}:/.test(host) ||
		/^fe80:/.test(host);
	if (privateHost) throw new WebhookUrlError('not_public');
	url.hash = '';
	return url.toString();
}

const secretContext = (connectionId: string) => `agent-webhook:${connectionId}`;

/**
 * Sets (or clears, with null) a connection's webhook. A new URL gets a new
 * signing secret, returned once so the founder can give it to their agent.
 */
export async function setWebhook(
	db: D1Database,
	masterKey: CryptoKey,
	input: { connectionId: string; byUserId: string; url: string | null }
): Promise<{ url: string | null; secret: string | null }> {
	const connection = await getConnection(db, input.connectionId);
	if (!connection) throw new ConnectionNotAllowedError();
	const agent = await getAgent(db, connection.agentId);
	const human = await humanPrincipalForUser(db, input.byUserId);
	if (!agent || agent.workspaceId !== human.workspace_id) throw new ConnectionNotAllowedError();
	if (!(human.is_admin === 1 || agent.ownerPrincipalId === human.id)) throw new ConnectionNotAllowedError();

	if (input.url === null || input.url.trim() === '') {
		await db
			.prepare(`UPDATE agent_connections SET webhook_url = NULL, webhook_secret_enc = NULL WHERE id = ?`)
			.bind(connection.id)
			.run();
		return { url: null, secret: null };
	}
	const url = checkWebhookUrl(input.url);
	const secret = newWebhookSecret();
	const sealed = await sealSecret(masterKey, secret, secretContext(connection.id));
	await db
		.prepare(`UPDATE agent_connections SET webhook_url = ?, webhook_secret_enc = ? WHERE id = ?`)
		.bind(url, sealed, connection.id)
		.run();
	return { url, secret };
}

/** Records action.decided for an external agent's proposal. Built-in agents don't need telling. */
export async function emitActionDecided(db: D1Database, actionId: string, now = new Date()): Promise<void> {
	const row = await db
		.prepare(
			`SELECT x.agent_principal_id, x.thread_id FROM agent_actions x
			 JOIN agents a ON a.principal_id = x.agent_principal_id
			 WHERE x.id = ? AND a.runtime = 'external'`
		)
		.bind(actionId)
		.first<{ agent_principal_id: string; thread_id: string | null }>();
	if (!row) return;
	await emitEvent(db, { agentId: row.agent_principal_id, type: 'action.decided', threadId: row.thread_id, actionId }, now);
}

/** What the agent receives. */
export function webhookPayload(event: {
	seq: number;
	agentId: string;
	type: string;
	threadId: string | null;
	emailId: string | null;
	actionId: string | null;
	timerId: string | null;
	createdAt: string;
}) {
	return {
		id: `evt_${event.seq}`,
		type: event.type,
		created_at: event.createdAt,
		agent_id: event.agentId,
		data: {
			thread_id: event.threadId,
			email_id: event.emailId,
			action_id: event.actionId,
			timer_id: event.timerId
		},
		// The cursor for check_new_mail, so polling and webhooks agree.
		cursor: String(event.seq)
	};
}

export function retryDelayMs(attempt: number): number {
	return Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.max(0, attempt - 1));
}

type DueDelivery = {
	id: string;
	connection_id: string;
	event_seq: number;
	attempt: number;
	agent_principal_id: string;
	type: string;
	thread_id: string | null;
	email_id: string | null;
	action_id: string | null;
	timer_id: string | null;
	event_created_at: string;
	webhook_url: string | null;
	connection_status: string;
};

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Sends due webhook deliveries, from the cron. Each is claimed first so two
 * crons never send one twice; a 2xx marks it delivered, anything else retries
 * with backoff until the event is a day old. An agent whose webhook has only
 * failed for a whole day is paused (story 10).
 */
export async function deliverWebhooks(
	db: D1Database,
	masterKey: CryptoKey | null,
	fetcher: Fetcher,
	now = new Date(),
	limit = 20
): Promise<{ delivered: number; failed: number; dead: number }> {
	const at = now.toISOString();
	const { results } = await db
		.prepare(
			`UPDATE webhook_deliveries SET claimed_at = ?
			 WHERE id IN (
			   SELECT id FROM webhook_deliveries
			   WHERE status = 'pending' AND next_retry_at <= ? AND (claimed_at IS NULL OR claimed_at < ?)
			   ORDER BY next_retry_at ASC LIMIT ?
			 )
			 RETURNING id`
		)
		.bind(at, at, new Date(now.getTime() - CLAIM_MS).toISOString(), limit)
		.all<{ id: string }>();
	const tally = { delivered: 0, failed: 0, dead: 0 };
	for (const { id } of results) {
		const row = await db
			.prepare(
				`SELECT d.id, d.connection_id, d.event_seq, d.attempt, e.agent_principal_id, e.type, e.thread_id, e.email_id,
				        e.action_id, e.timer_id, e.created_at AS event_created_at, c.webhook_url, c.status AS connection_status
				 FROM webhook_deliveries d
				 JOIN agent_events e ON e.seq = d.event_seq
				 JOIN agent_connections c ON c.id = d.connection_id
				 WHERE d.id = ?`
			)
			.bind(id)
			.first<DueDelivery>();
		if (!row) continue;
		const outcome = await deliverOne(db, masterKey, fetcher, row, now);
		tally[outcome]++;
	}
	return tally;
}

async function deliverOne(
	db: D1Database,
	masterKey: CryptoKey | null,
	fetcher: Fetcher,
	row: DueDelivery,
	now: Date
): Promise<'delivered' | 'failed' | 'dead'> {
	const attempt = row.attempt + 1;
	const markDead = async (error: string, statusCode: number | null) => {
		await db
			.prepare(`UPDATE webhook_deliveries SET status = 'dead', attempt = ?, status_code = ?, last_error = ?, claimed_at = NULL WHERE id = ?`)
			.bind(attempt, statusCode, error.slice(0, 300), row.id)
			.run();
		return 'dead' as const;
	};
	// Revoked, or the URL was removed: nothing to send to.
	if (row.connection_status !== 'active' || !row.webhook_url) return markDead('no_webhook', null);

	const sealed = await webhookSecretFor(db, row.connection_id);
	if (!sealed || !masterKey) return markDead('no_secret', null);
	const secret = await openSecret(masterKey, sealed, secretContext(row.connection_id));

	const body = JSON.stringify(
		webhookPayload({
			seq: row.event_seq,
			agentId: row.agent_principal_id,
			type: row.type,
			threadId: row.thread_id,
			emailId: row.email_id,
			actionId: row.action_id,
			timerId: row.timer_id,
			createdAt: row.event_created_at
		})
	);
	const messageId = `evt_${row.event_seq}`;
	const timestamp = Math.floor(now.getTime() / 1000);
	let statusCode: number | null = null;
	let error = '';
	try {
		const response = await fetcher(row.webhook_url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'user-agent': 'CloudMail-Webhooks/1',
				'webhook-id': messageId,
				'webhook-timestamp': String(timestamp),
				'webhook-signature': await signWebhook(secret, messageId, timestamp, body)
			},
			body,
			redirect: 'manual',
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		});
		statusCode = response.status;
		if (response.ok) {
			await db
				.prepare(
					`UPDATE webhook_deliveries SET status = 'delivered', attempt = ?, status_code = ?, delivered_at = ?, claimed_at = NULL, last_error = NULL
					 WHERE id = ?`
				)
				.bind(attempt, statusCode, now.toISOString(), row.id)
				.run();
			return 'delivered';
		}
		error = `http_${statusCode}`;
	} catch (failure) {
		error = failure instanceof Error ? failure.name : 'error';
	}

	if (now.getTime() - Date.parse(row.event_created_at) >= DELIVERY_WINDOW_MS) {
		const dead = await markDead(error, statusCode);
		await pauseIfFailingForADay(db, row.connection_id, row.agent_principal_id, now);
		return dead;
	}
	await db
		.prepare(
			`UPDATE webhook_deliveries SET attempt = ?, status_code = ?, last_error = ?, next_retry_at = ?, claimed_at = NULL WHERE id = ?`
		)
		.bind(attempt, statusCode, error.slice(0, 300), new Date(now.getTime() + retryDelayMs(attempt)).toISOString(), row.id)
		.run();
	return 'failed';
}

/** Nothing delivered to this webhook in the last 24 hours, only failures: pause the agent. */
async function pauseIfFailingForADay(db: D1Database, connectionId: string, agentId: string, now: Date): Promise<void> {
	const dayAgo = new Date(now.getTime() - DELIVERY_WINDOW_MS).toISOString();
	const delivered = await db
		.prepare(`SELECT 1 AS ok FROM webhook_deliveries WHERE connection_id = ? AND status = 'delivered' AND delivered_at >= ? LIMIT 1`)
		.bind(connectionId, dayAgo)
		.first<{ ok: number }>();
	if (!delivered) await pauseForFailingWebhooks(db, agentId);
}

export type DeliveryLogRow = {
	id: string;
	type: string;
	status: string;
	attempt: number;
	statusCode: number | null;
	lastError: string | null;
	createdAt: string;
	deliveredAt: string | null;
};

export async function recentDeliveries(db: D1Database, connectionId: string, limit = 20): Promise<DeliveryLogRow[]> {
	const { results } = await db
		.prepare(
			`SELECT d.id, e.type, d.status, d.attempt, d.status_code, d.last_error, d.created_at, d.delivered_at
			 FROM webhook_deliveries d JOIN agent_events e ON e.seq = d.event_seq
			 WHERE d.connection_id = ? ORDER BY d.created_at DESC LIMIT ?`
		)
		.bind(connectionId, limit)
		.all<{
			id: string;
			type: string;
			status: string;
			attempt: number;
			status_code: number | null;
			last_error: string | null;
			created_at: string;
			delivered_at: string | null;
		}>();
	return results.map((row) => ({
		id: row.id,
		type: row.type,
		status: row.status,
		attempt: row.attempt,
		statusCode: row.status_code,
		lastError: row.last_error,
		createdAt: row.created_at,
		deliveredAt: row.delivered_at
	}));
}
