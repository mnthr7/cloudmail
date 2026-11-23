import type { D1Database } from '@cloudflare/workers-types';
import { externalDefaultDefinition, type AgentDefinition } from '#lib/agents/definition.ts';
import { hashToken } from './crypto';
import { createAgent, getAgent, humanPrincipalForUser, type AgentRecord } from './agents-store';

/**
 * External agents: how they connect, what they called, what they need to hear
 * about (docs/specs/external-agents.md, X1, X4, X6). What they may *do* is the
 * platform's (agents-store, policy); nothing here grants anything.
 */

export type ConnectionStatus = 'active' | 'revoked';

export type AgentConnection = {
	id: string;
	agentId: string;
	/** How it signs in: an OAuth grant, or an API key. */
	auth: 'oauth' | 'api_key';
	/** The start of an API key, to tell keys apart. Null for OAuth. */
	keyHint: string | null;
	clientName: string;
	clientId: string;
	grantRef: string | null;
	mailboxUserId: string;
	webhookUrl: string | null;
	hasWebhookSecret: boolean;
	status: ConnectionStatus;
	lastSeenAt: string | null;
	createdAt: string;
};

type ConnectionRow = {
	id: string;
	agent_principal_id: string;
	auth: 'oauth' | 'api_key';
	key_hint: string | null;
	client_name: string;
	client_id: string;
	grant_ref: string | null;
	mailbox_user_id: string;
	webhook_url: string | null;
	webhook_secret_enc: string | null;
	status: ConnectionStatus;
	last_seen_at: string | null;
	created_at: string;
};

function toConnection(row: ConnectionRow): AgentConnection {
	return {
		id: row.id,
		agentId: row.agent_principal_id,
		auth: row.auth,
		keyHint: row.key_hint,
		clientName: row.client_name,
		clientId: row.client_id,
		grantRef: row.grant_ref,
		mailboxUserId: row.mailbox_user_id,
		webhookUrl: row.webhook_url,
		hasWebhookSecret: !!row.webhook_secret_enc,
		status: row.status,
		lastSeenAt: row.last_seen_at,
		createdAt: row.created_at
	};
}

export const MAX_CLIENT_NAME = 80;

/** A client's self-reported name, cut down to something safe to show. Never trusted for anything else. */
export function cleanClientName(name: unknown): string {
	const text = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
	return (text || 'Unnamed client').slice(0, MAX_CLIENT_NAME);
}

export type ExternalAgentInput = {
	ownerUserId: string;
	displayName: string;
	job: string;
	readAddresses: string[];
	sendAs: string[];
	/** Levels chosen by the founder, over the external defaults. */
	levels?: Partial<Record<string, string>>;
};

/** A new external agent in shadow mode, with no connection yet. */
export async function hireExternalAgent(db: D1Database, input: ExternalAgentInput, now = new Date()): Promise<AgentRecord> {
	const base = externalDefaultDefinition(input.job, { readAddresses: input.readAddresses, sendAs: input.sendAs });
	const definition: AgentDefinition = { ...base, capabilities: { ...base.capabilities } };
	for (const [capability, level] of Object.entries(input.levels ?? {})) {
		// parseDefinition (inside createAgent) rejects unknown names and levels.
		(definition.capabilities as Record<string, unknown>)[capability] = { level };
	}
	return createAgent(
		db,
		{ ownerUserId: input.ownerUserId, displayName: input.displayName, definition, runtime: 'external' },
		now
	);
}

/**
 * Hires an external agent from the consent screen: a new agent principal in
 * shadow mode, plus the connection its OAuth grant points at.
 */
export async function createExternalAgent(
	db: D1Database,
	input: ExternalAgentInput & { clientName: string; clientId: string },
	now = new Date()
): Promise<{ agent: AgentRecord; connection: AgentConnection }> {
	const agent = await hireExternalAgent(db, input, now);
	const id = `ac_${crypto.randomUUID()}`;
	await db
		.prepare(
			`INSERT INTO agent_connections (id, agent_principal_id, kind, client_name, client_id, mailbox_user_id, status, created_at)
			 VALUES (?, ?, 'mcp', ?, ?, ?, 'active', ?)`
		)
		.bind(id, agent.id, cleanClientName(input.clientName), input.clientId, input.ownerUserId, now.toISOString())
		.run();
	const connection = await getConnection(db, id);
	if (!connection) throw new Error('Failed to record the connection');
	return { agent, connection };
}

/**
 * Connects a client again as an agent that already exists (spec X2: the
 * founder picks it on the consent screen). Its old connections are revoked,
 * so only the newest grant works.
 */
export async function reconnectExternalAgent(
	db: D1Database,
	input: { agentId: string; byUserId: string; clientName: string; clientId: string },
	now = new Date()
): Promise<{ agent: AgentRecord; connection: AgentConnection }> {
	const agent = await getAgent(db, input.agentId);
	const human = await humanPrincipalForUser(db, input.byUserId);
	if (!agent || agent.runtime !== 'external' || agent.workspaceId !== human.workspace_id) {
		throw new ConnectionNotAllowedError();
	}
	if (!(human.is_admin === 1 || agent.ownerPrincipalId === human.id)) throw new ConnectionNotAllowedError();
	const id = `ac_${crypto.randomUUID()}`;
	const stamp = now.toISOString();
	await db.batch([
		db
			.prepare(`UPDATE agent_connections SET status = 'revoked', revoked_at = ? WHERE agent_principal_id = ? AND status = 'active'`)
			.bind(stamp, agent.id),
		db
			.prepare(
				`INSERT INTO agent_connections (id, agent_principal_id, kind, client_name, client_id, mailbox_user_id, status, created_at)
				 VALUES (?, ?, 'mcp', ?, ?, ?, 'active', ?)`
			)
			.bind(id, agent.id, cleanClientName(input.clientName), input.clientId, input.byUserId, stamp)
	]);
	const connection = await getConnection(db, id);
	if (!connection) throw new Error('Failed to record the connection');
	return { agent, connection };
}

/** External agents this person may reconnect a client as (theirs, or any if they're an admin). */
export async function reconnectableAgents(db: D1Database, userId: string): Promise<Array<{ id: string; name: string }>> {
	const human = await humanPrincipalForUser(db, userId);
	const { results } = await db
		.prepare(
			`SELECT p.id, p.display_name AS name FROM principals p JOIN agents a ON a.principal_id = p.id
			 WHERE a.runtime = 'external' AND p.workspace_id = ? AND (p.owner_principal_id = ? OR ? = 1)
			 ORDER BY p.created_at DESC`
		)
		.bind(human.workspace_id, human.id, human.is_admin)
		.all<{ id: string; name: string }>();
	return results;
}

// ---- API keys (X9) ------------------------------------------------------------

/** Every key starts with this, so leaks are easy to spot and the worker can tell keys from OAuth tokens. */
export const API_KEY_PREFIX = 'cmk_';

export function isApiKey(token: string): boolean {
	return token.startsWith(API_KEY_PREFIX) && token.length > API_KEY_PREFIX.length + 20;
}

function newApiKey(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	const text = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	return `${API_KEY_PREFIX}${text}`;
}

/**
 * A new API key for an external agent. Its earlier keys stop working (one key
 * per agent, so rotating is one click); its OAuth connections are left alone.
 * Returns the key once: only its hash is kept.
 */
export async function createApiKey(
	db: D1Database,
	input: { agentId: string; byUserId: string },
	now = new Date()
): Promise<{ connection: AgentConnection; key: string }> {
	const agent = await getAgent(db, input.agentId);
	const human = await humanPrincipalForUser(db, input.byUserId);
	if (!agent || agent.runtime !== 'external' || agent.workspaceId !== human.workspace_id) {
		throw new ConnectionNotAllowedError();
	}
	if (!(human.is_admin === 1 || agent.ownerPrincipalId === human.id)) throw new ConnectionNotAllowedError();
	const key = newApiKey();
	const id = `ac_${crypto.randomUUID()}`;
	const stamp = now.toISOString();
	// Whose mailbox it works in: the person the agent was hired by, as with OAuth.
	const owner = await db
		.prepare(`SELECT u.user_id FROM principals a JOIN principals u ON u.id = a.owner_principal_id WHERE a.id = ?`)
		.bind(agent.id)
		.first<{ user_id: string | null }>();
	const mailboxUserId = owner?.user_id ?? input.byUserId;
	await db.batch([
		db
			.prepare(
				`UPDATE agent_connections SET status = 'revoked', revoked_at = ?
				 WHERE agent_principal_id = ? AND auth = 'api_key' AND status = 'active'`
			)
			.bind(stamp, agent.id),
		db
			.prepare(
				`INSERT INTO agent_connections
				   (id, agent_principal_id, kind, auth, client_name, client_id, mailbox_user_id, key_hash, key_hint, status, created_at)
				 VALUES (?, ?, 'mcp', 'api_key', 'API key', ?, ?, ?, ?, 'active', ?)`
			)
			.bind(id, agent.id, id, mailboxUserId, await hashToken(key), key.slice(0, API_KEY_PREFIX.length + 6), stamp)
	]);
	const connection = await getConnection(db, id);
	if (!connection) throw new Error('Failed to record the key');
	return { connection, key };
}

/** The live connection an API key belongs to, or null. */
export async function connectionForApiKey(db: D1Database, key: string): Promise<AgentConnection | null> {
	if (!isApiKey(key)) return null;
	const row = await db
		.prepare(`SELECT * FROM agent_connections WHERE key_hash = ? AND auth = 'api_key' AND status = 'active'`)
		.bind(await hashToken(key))
		.first<ConnectionRow>();
	return row ? toConnection(row) : null;
}

export async function setGrantRef(db: D1Database, connectionId: string, grantRef: string): Promise<void> {
	await db.prepare(`UPDATE agent_connections SET grant_ref = ? WHERE id = ?`).bind(grantRef, connectionId).run();
}

export async function getConnection(db: D1Database, connectionId: string): Promise<AgentConnection | null> {
	const row = await db.prepare(`SELECT * FROM agent_connections WHERE id = ?`).bind(connectionId).first<ConnectionRow>();
	return row ? toConnection(row) : null;
}

export async function connectionsForAgent(db: D1Database, agentId: string): Promise<AgentConnection[]> {
	const { results } = await db
		.prepare(`SELECT * FROM agent_connections WHERE agent_principal_id = ? ORDER BY created_at DESC`)
		.bind(agentId)
		.all<ConnectionRow>();
	return results.map(toConnection);
}

/** The sealed webhook secret, for the sender only. */
export async function webhookSecretFor(db: D1Database, connectionId: string): Promise<string | null> {
	const row = await db
		.prepare(`SELECT webhook_secret_enc FROM agent_connections WHERE id = ?`)
		.bind(connectionId)
		.first<{ webhook_secret_enc: string | null }>();
	return row?.webhook_secret_enc ?? null;
}

const TOUCH_EVERY_MS = 60_000;

/** Records that the client was here, at most once a minute so reads stay cheap. */
export async function touchConnection(db: D1Database, connection: AgentConnection, now = new Date()): Promise<void> {
	if (connection.lastSeenAt && now.getTime() - Date.parse(connection.lastSeenAt) < TOUCH_EVERY_MS) return;
	await db
		.prepare(`UPDATE agent_connections SET last_seen_at = ? WHERE id = ?`)
		.bind(now.toISOString(), connection.id)
		.run();
}

export class ConnectionNotAllowedError extends Error {
	readonly status = 403;
	constructor() {
		super('Not allowed');
		this.name = 'ConnectionNotAllowedError';
	}
}

/**
 * Stops a connection for good. Like pausing, anyone in the workspace can pull
 * this brake. Returns the grant to revoke in the OAuth store too.
 */
export async function revokeConnection(
	db: D1Database,
	input: { connectionId: string; byUserId: string },
	now = new Date()
): Promise<AgentConnection> {
	const connection = await getConnection(db, input.connectionId);
	if (!connection) throw new ConnectionNotAllowedError();
	const agent = await getAgent(db, connection.agentId);
	const human = await humanPrincipalForUser(db, input.byUserId);
	if (!agent || agent.workspaceId !== human.workspace_id) throw new ConnectionNotAllowedError();
	await db
		.prepare(`UPDATE agent_connections SET status = 'revoked', revoked_at = ? WHERE id = ?`)
		.bind(now.toISOString(), connection.id)
		.run();
	return { ...connection, status: 'revoked' };
}

// ---- Audit (X6) -------------------------------------------------------------

export type AuditDecision =
	| 'read'
	| 'executed'
	| 'queued'
	| 'shadowed'
	| 'rejected'
	| 'error'
	| 'rate_limited'
	| 'refused';

const REDACT_STRING_AT = 200;

/** A copy of tool arguments safe to keep and show: long text cut short. */
export function redactArgs(args: unknown): unknown {
	if (typeof args === 'string') {
		return args.length > REDACT_STRING_AT ? `${args.slice(0, REDACT_STRING_AT)}… (${args.length} chars)` : args;
	}
	if (Array.isArray(args)) return args.slice(0, 50).map(redactArgs);
	if (args && typeof args === 'object') {
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(args).slice(0, 50)) out[key] = redactArgs(value);
		return out;
	}
	return args;
}

export async function auditToolCall(
	db: D1Database,
	input: {
		agentId: string;
		connectionId: string | null;
		tool: string;
		args: unknown;
		decision: AuditDecision;
		reason?: string | null;
		actionId?: string | null;
		latencyMs: number;
	},
	now = new Date()
): Promise<void> {
	const json = JSON.stringify(input.args ?? {});
	await db
		.prepare(
			`INSERT INTO tool_call_audit
			   (id, agent_principal_id, connection_id, tool, args_hash, args_redacted_json, decision, reason, action_id, latency_ms, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			crypto.randomUUID(),
			input.agentId,
			input.connectionId,
			input.tool,
			await hashToken(json),
			JSON.stringify(redactArgs(input.args ?? {})),
			input.decision,
			input.reason ?? null,
			input.actionId ?? null,
			Math.max(0, Math.round(input.latencyMs)),
			now.toISOString()
		)
		.run();
}

export type AuditRow = {
	id: string;
	tool: string;
	argsRedacted: unknown;
	decision: AuditDecision;
	reason: string | null;
	actionId: string | null;
	latencyMs: number;
	createdAt: string;
};

export async function recentToolCalls(db: D1Database, agentId: string, limit = 50): Promise<AuditRow[]> {
	const { results } = await db
		.prepare(
			`SELECT id, tool, args_redacted_json, decision, reason, action_id, latency_ms, created_at
			 FROM tool_call_audit WHERE agent_principal_id = ? ORDER BY created_at DESC LIMIT ?`
		)
		.bind(agentId, limit)
		.all<{
			id: string;
			tool: string;
			args_redacted_json: string;
			decision: AuditDecision;
			reason: string | null;
			action_id: string | null;
			latency_ms: number;
			created_at: string;
		}>();
	return results.map((row) => ({
		id: row.id,
		tool: row.tool,
		argsRedacted: safeJson(row.args_redacted_json),
		decision: row.decision,
		reason: row.reason,
		actionId: row.action_id,
		latencyMs: row.latency_ms,
		createdAt: row.created_at
	}));
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** Audit rows older than this are deleted by the cron (X6: kept 90 days). */
export const AUDIT_RETENTION_DAYS = 90;

export async function pruneAudit(db: D1Database, now = new Date()): Promise<number> {
	const cutoff = new Date(now.getTime() - AUDIT_RETENTION_DAYS * 86_400_000).toISOString();
	const result = await db.prepare(`DELETE FROM tool_call_audit WHERE created_at < ?`).bind(cutoff).run();
	return result.meta?.changes ?? 0;
}

// ---- Rate limits and auto-pause (X6) ----------------------------------------

export const RATE_LIMIT_PER_MINUTE = 60;
export const RATE_LIMIT_PER_DAY = 2000;

export type RateLimitResult = { ok: true } | { ok: false; window: 'minute' | 'day'; retryAfterSeconds: number };

/** Counts recent tool calls. A call over the limit is audited as `rate_limited` and refused. */
export async function checkRateLimit(
	db: D1Database,
	agentId: string,
	now = new Date(),
	limits = { perMinute: RATE_LIMIT_PER_MINUTE, perDay: RATE_LIMIT_PER_DAY }
): Promise<RateLimitResult> {
	const minuteAgo = new Date(now.getTime() - 60_000).toISOString();
	const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
	const row = await db
		.prepare(
			`SELECT
			   SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS minute,
			   COUNT(*) AS day
			 FROM tool_call_audit
			 WHERE agent_principal_id = ? AND created_at >= ? AND decision <> 'rate_limited'`
		)
		.bind(minuteAgo, agentId, dayAgo)
		.first<{ minute: number | null; day: number }>();
	if ((row?.minute ?? 0) >= limits.perMinute) return { ok: false, window: 'minute', retryAfterSeconds: 60 };
	if ((row?.day ?? 0) >= limits.perDay) return { ok: false, window: 'day', retryAfterSeconds: 3600 };
	return { ok: true };
}

/** More rejected proposals than this in an hour pauses the agent (story 10). */
export const AUTO_PAUSE_REJECTIONS_PER_HOUR = 10;

export type AutoPauseReason = 'too_many_rejections' | 'webhooks_failing';

export const AUTO_PAUSE_LABELS: Record<AutoPauseReason, string> = {
	too_many_rejections: 'Paused by CloudMail: more than 10 of its requests were refused in an hour.',
	webhooks_failing: 'Paused by CloudMail: its webhook has been failing for 24 hours.'
};

async function pauseAutomatically(db: D1Database, agentId: string, reason: AutoPauseReason): Promise<boolean> {
	const result = await db
		.prepare(`UPDATE agents SET status = 'paused', paused_reason = ? WHERE principal_id = ? AND status <> 'paused'`)
		.bind(reason, agentId)
		.run();
	return (result.meta?.changes ?? 0) > 0;
}

/** Pauses the agent if it keeps getting refused. Returns the reason when it paused it just now. */
export async function maybeAutoPause(db: D1Database, agentId: string, now = new Date()): Promise<AutoPauseReason | null> {
	const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS rejected FROM agent_actions
			 WHERE agent_principal_id = ? AND status = 'rejected' AND created_at >= ?`
		)
		.bind(agentId, hourAgo)
		.first<{ rejected: number }>();
	if ((row?.rejected ?? 0) > AUTO_PAUSE_REJECTIONS_PER_HOUR && (await pauseAutomatically(db, agentId, 'too_many_rejections'))) {
		return 'too_many_rejections';
	}
	return null;
}

export async function pauseForFailingWebhooks(db: D1Database, agentId: string): Promise<boolean> {
	return pauseAutomatically(db, agentId, 'webhooks_failing');
}

// ---- Events (X4) ------------------------------------------------------------

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

export const MAX_EVENTS_PER_PAGE = 100;

/** Events after `cursor` (a seq), oldest first. The next cursor is the last seq returned, or the same cursor. */
export async function eventsSince(
	db: D1Database,
	agentId: string,
	cursor: number,
	limit = MAX_EVENTS_PER_PAGE
): Promise<{ events: AgentEvent[]; cursor: number; more: boolean }> {
	const take = Math.min(Math.max(1, limit), MAX_EVENTS_PER_PAGE);
	const { results } = await db
		.prepare(
			`SELECT seq, type, thread_id, email_id, action_id, timer_id, created_at
			 FROM agent_events WHERE agent_principal_id = ? AND seq > ?
			 ORDER BY seq ASC LIMIT ?`
		)
		.bind(agentId, cursor, take + 1)
		.all<{
			seq: number;
			type: AgentEventType;
			thread_id: string | null;
			email_id: string | null;
			action_id: string | null;
			timer_id: string | null;
			created_at: string;
		}>();
	const page = results.slice(0, take);
	return {
		events: page.map((row) => ({
			seq: row.seq,
			type: row.type,
			threadId: row.thread_id,
			emailId: row.email_id,
			actionId: row.action_id,
			timerId: row.timer_id,
			createdAt: row.created_at
		})),
		cursor: page.length ? page[page.length - 1].seq : cursor,
		more: results.length > take
	};
}

/** The newest seq, for a client starting fresh ("only tell me about mail from now on"). */
export async function latestEventSeq(db: D1Database, agentId: string): Promise<number> {
	const row = await db
		.prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM agent_events WHERE agent_principal_id = ?`)
		.bind(agentId)
		.first<{ seq: number }>();
	return row?.seq ?? 0;
}

/** External agents (not paused) whose read scope includes any of these addresses, for this mailbox. */
export async function externalAgentsReading(
	db: D1Database,
	mailboxUserId: string,
	addresses: string[]
): Promise<string[]> {
	const wanted = new Set(addresses.map((address) => address.trim().toLowerCase()).filter(Boolean));
	if (wanted.size === 0) return [];
	const { results } = await db
		.prepare(
			`SELECT DISTINCT a.principal_id AS id, v.definition_json
			 FROM agents a
			 JOIN agent_versions v ON v.id = a.current_version_id
			 JOIN agent_connections c ON c.agent_principal_id = a.principal_id AND c.status = 'active'
			 WHERE a.runtime = 'external' AND a.status <> 'paused' AND c.mailbox_user_id = ?`
		)
		.bind(mailboxUserId)
		.all<{ id: string; definition_json: string }>();
	const readers: string[] = [];
	for (const row of results) {
		const definition = safeJson(row.definition_json) as AgentDefinition | null;
		const read = definition?.scope?.read?.addresses ?? [];
		if (read.some((address) => wanted.has(address))) readers.push(row.id);
	}
	return readers;
}
