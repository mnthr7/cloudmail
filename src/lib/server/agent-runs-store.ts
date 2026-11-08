import type { D1Database } from '@cloudflare/workers-types';
import { parseDefinition } from '#lib/agents/definition.ts';
import type { AgentStatus } from '#lib/agents/policy.ts';
import { parseEmailAddresses } from '#lib/email-address.ts';
import type { CategoryHeaders } from '#lib/organizing/categories.ts';
import {
	AgentNotFoundError,
	canManage,
	getAgent,
	humanPrincipalForUser,
	liveWorkspaceAddresses,
	NotAllowedError,
	sendableForAuthor
} from './agents-store.ts';

/**
 * The queue of agent runs (docs/specs/agent-staff-platform.md, A5 and §8.2).
 * Mail and "Ask an agent" add runs here; the cron claims them. Each trigger
 * runs at most once per agent.
 */

export type RunStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export type TriggerKind = 'mail' | 'ask';

export type AgentRun = {
	id: string;
	workspace_id: string;
	agent_principal_id: string;
	mailbox_user_id: string;
	email_id: string;
	trigger_kind: TriggerKind;
	trigger_ref: string;
	request: string | null;
	requested_by_principal_id: string | null;
	status: RunStatus;
	attempts: number;
	created_at: string;
};

export const MAX_RUN_ATTEMPTS = 3;
/** A run still marked running after this long was cut off, so it can be claimed again. */
const STALE_RUN_MS = 10 * 60 * 1000;
export const MAX_REQUEST_LENGTH = 2000;

/** Mail a machine sent, which an agent must never answer (A14). */
export function isAutomatedMail(headers: Pick<CategoryHeaders, 'autoSubmitted' | 'precedence'>): boolean {
	const auto = headers.autoSubmitted?.trim().toLowerCase();
	if (auto && auto !== 'no') return true;
	const precedence = headers.precedence?.trim().toLowerCase();
	return precedence === 'bulk' || precedence === 'junk' || precedence === 'list' || precedence === 'auto_reply';
}

/**
 * New inbound mail: wakes the agent watching the address it was sent to (A5).
 * One agent per message: if several watch the same address, the first hired
 * does the work. An address only counts while it is still in the mailbox
 * owner's name and the agent's author could still hand it out.
 * Returns the number of runs added.
 */
export async function enqueueMailRuns(
	db: D1Database,
	userId: string,
	emailId: string,
	headers: Pick<CategoryHeaders, 'autoSubmitted' | 'precedence'>,
	now = new Date()
): Promise<number> {
	if (isAutomatedMail(headers)) return 0;

	const email = await db
		.prepare(`SELECT to_addr, cc_addr, direction FROM emails WHERE id = ? AND user_id = ?`)
		.bind(emailId, userId)
		.first<{ to_addr: string; cc_addr: string | null; direction: string }>();
	if (!email || email.direction !== 'inbound') return 0;
	const recipients = new Set(parseEmailAddresses([email.to_addr, email.cc_addr ?? '']).map((a) => a.toLowerCase()));

	const human = await db
		.prepare(`SELECT workspace_id FROM principals WHERE user_id = ? AND kind = 'human'`)
		.bind(userId)
		.first<{ workspace_id: string }>();
	if (!human) return 0;

	const { results } = await db
		.prepare(
			`SELECT p.id, v.definition_json, v.created_by_principal_id
			 FROM principals p
			 JOIN agents a ON a.principal_id = p.id
			 JOIN agent_versions v ON v.id = a.current_version_id
			 WHERE p.workspace_id = ? AND p.kind = 'agent' AND a.status != 'paused'
			 ORDER BY p.created_at ASC, p.id ASC`
		)
		.bind(human.workspace_id)
		.all<{ id: string; definition_json: string; created_by_principal_id: string | null }>();
	if (results.length === 0) return 0;

	const workspaceAddresses = await liveWorkspaceAddresses(db, human.workspace_id);
	for (const row of results) {
		let watch: string[];
		try {
			watch = parseDefinition(JSON.parse(row.definition_json)).triggers.watch;
		} catch {
			continue;
		}
		const matched = watch.filter((address) => recipients.has(address) && workspaceAddresses.get(address) === userId);
		if (matched.length === 0) continue;
		const sendable = new Set(
			await sendableForAuthor(db, human.workspace_id, workspaceAddresses, row.created_by_principal_id)
		);
		if (!matched.some((address) => sendable.has(address))) continue;

		const result = await db
			.prepare(
				`INSERT OR IGNORE INTO agent_runs
				 (id, workspace_id, agent_principal_id, mailbox_user_id, email_id, trigger_kind, trigger_ref, created_at)
				 VALUES (?, ?, ?, ?, ?, 'mail', ?, ?)`
			)
			.bind(crypto.randomUUID(), human.workspace_id, row.id, userId, emailId, emailId, now.toISOString())
			.run();
		return result.meta.changes ?? 0;
	}
	return 0;
}

export class AskError extends Error {
	readonly status = 400;

	constructor(readonly code: 'request' | 'email' | 'paused') {
		super(code);
		this.name = 'AskError';
	}
}

/**
 * A human asks an agent to help with a thread in their own mailbox. The
 * request is an instruction (A11), so only someone who could change the agent
 * may give it one.
 */
export async function enqueueAskRun(
	db: D1Database,
	input: { agentId: string; byUserId: string; emailId: string; request: string },
	now = new Date()
): Promise<string> {
	const [agent, human] = await Promise.all([getAgent(db, input.agentId), humanPrincipalForUser(db, input.byUserId)]);
	if (!agent || agent.workspaceId !== human.workspace_id) throw new AgentNotFoundError();
	if (!canManage(agent, human)) throw new NotAllowedError();
	if (agent.status === 'paused') throw new AskError('paused');

	const request = input.request.trim();
	if (!request || request.length > MAX_REQUEST_LENGTH) throw new AskError('request');

	const email = await db
		.prepare(`SELECT id FROM emails WHERE id = ? AND user_id = ? AND deleted_at IS NULL`)
		.bind(input.emailId, input.byUserId)
		.first<{ id: string }>();
	if (!email) throw new AskError('email');

	const id = crypto.randomUUID();
	await db
		.prepare(
			`INSERT INTO agent_runs
			 (id, workspace_id, agent_principal_id, mailbox_user_id, email_id, trigger_kind, trigger_ref,
			  request, requested_by_principal_id, created_at)
			 VALUES (?, ?, ?, ?, ?, 'ask', ?, ?, ?, ?)`
		)
		.bind(id, agent.workspaceId, agent.id, input.byUserId, email.id, id, request, human.id, now.toISOString())
		.run();
	return id;
}

/**
 * Claims up to `limit` runs for this cron tick, oldest first. A run left in
 * `running` by a tick that was cut off is claimed again; after the last
 * attempt it is marked failed instead.
 */
/** Claims due runs, only in the given workspaces (those with a working provider key). */
export async function claimRuns(
	db: D1Database,
	limit: number,
	now = new Date(),
	workspaceIds: string[] = []
): Promise<AgentRun[]> {
	if (workspaceIds.length === 0) return [];
	const stale = new Date(now.getTime() - STALE_RUN_MS).toISOString();
	await db
		.prepare(
			`UPDATE agent_runs SET status = 'failed', outcome = 'gave_up', finished_at = ?
			 WHERE status = 'running' AND started_at < ? AND attempts >= ?`
		)
		.bind(now.toISOString(), stale, MAX_RUN_ATTEMPTS)
		.run();

	const { results } = await db
		.prepare(
			`UPDATE agent_runs SET status = 'running', started_at = ?, attempts = attempts + 1
			 WHERE id IN (
			   SELECT id FROM agent_runs
			   WHERE (status = 'pending' OR (status = 'running' AND started_at < ?)) AND attempts < ?
			     AND workspace_id IN (SELECT value FROM json_each(?))
			   ORDER BY created_at ASC LIMIT ?
			 )
			 RETURNING id, workspace_id, agent_principal_id, mailbox_user_id, email_id, trigger_kind, trigger_ref,
			           request, requested_by_principal_id, status, attempts, created_at`
		)
		.bind(now.toISOString(), stale, MAX_RUN_ATTEMPTS, JSON.stringify(workspaceIds), limit)
		.all<AgentRun>();
	return results;
}

/** Puts a claimed run back to wait, without counting the attempt: it never reached the model. */
export async function requeueRun(db: D1Database, runId: string, outcome: string): Promise<void> {
	await db
		.prepare(
			`UPDATE agent_runs SET status = 'pending', outcome = ?, attempts = MAX(attempts - 1, 0), finished_at = NULL
			 WHERE id = ?`
		)
		.bind(outcome, runId)
		.run();
}

export type RunUsage = { model: string; inputTokens: number; outputTokens: number; costMicros: number };

/** Adds one model response's usage to the run straight away, so a later failure can't lose it. */
export async function addRunUsage(db: D1Database, runId: string, usage: RunUsage): Promise<void> {
	await db
		.prepare(
			`UPDATE agent_runs
			 SET model = ?, input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cost_micros = cost_micros + ?
			 WHERE id = ?`
		)
		.bind(usage.model, usage.inputTokens, usage.outputTokens, usage.costMicros, runId)
		.run();
}

/** Records how a run ended, and what it cost so far. */
export async function finishRun(
	db: D1Database,
	runId: string,
	result: {
		status: Exclude<RunStatus, 'running'>;
		outcome: string;
		summary?: string;
		versionId?: string;
		usage?: RunUsage;
	},
	now = new Date()
): Promise<void> {
	await db
		.prepare(
			`UPDATE agent_runs
			 SET status = ?, outcome = ?, summary = COALESCE(?, summary), version_id = COALESCE(?, version_id),
			     model = COALESCE(?, model),
			     input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cost_micros = cost_micros + ?,
			     finished_at = CASE WHEN ? = 'pending' THEN NULL ELSE ? END
			 WHERE id = ?`
		)
		.bind(
			result.status,
			result.outcome.slice(0, 200),
			result.summary?.slice(0, 2000) ?? null,
			result.versionId ?? null,
			result.usage?.model ?? null,
			result.usage?.inputTokens ?? 0,
			result.usage?.outputTokens ?? 0,
			result.usage?.costMicros ?? 0,
			result.status,
			now.toISOString(),
			runId
		)
		.run();
}

function monthStart(now: Date): string {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** What an agent's runs have cost this calendar month (UTC), in micro-dollars. */
export async function spentThisMonth(db: D1Database, agentId: string, now = new Date()): Promise<number> {
	const row = await db
		.prepare(`SELECT COALESCE(SUM(cost_micros), 0) AS spent FROM agent_runs WHERE agent_principal_id = ? AND created_at >= ?`)
		.bind(agentId, monthStart(now))
		.first<{ spent: number }>();
	return row?.spent ?? 0;
}

/** Pauses an agent that reached its monthly budget (A10). */
export async function pauseForBudget(db: D1Database, agentId: string): Promise<void> {
	await db.prepare(`UPDATE agents SET status = 'paused' WHERE principal_id = ?`).bind(agentId).run();
}

/** Whether the run already recorded proposals, so a retry doesn't propose them twice. */
export async function runHasProposals(db: D1Database, runId: string): Promise<boolean> {
	const row = await db.prepare(`SELECT 1 AS found FROM agent_actions WHERE run_id = ? LIMIT 1`).bind(runId).first();
	return !!row;
}

export type RunSummary = {
	id: string;
	agentId: string;
	agentName: string;
	triggerKind: TriggerKind;
	emailId: string;
	subject: string | null;
	status: RunStatus;
	outcome: string | null;
	summary: string | null;
	costMicros: number;
	createdAt: string;
};

/**
 * Recent runs in the user's workspace, newest first, for the Staff page. The
 * subject and summary show only for threads in the user's own mailbox.
 */
export async function listRecentRuns(db: D1Database, userId: string, limit = 20): Promise<RunSummary[]> {
	const human = await humanPrincipalForUser(db, userId);
	const { results } = await db
		.prepare(
			`SELECT r.id, r.agent_principal_id, p.display_name, r.trigger_kind, r.email_id, r.status, r.outcome,
			        CASE WHEN r.mailbox_user_id = ? THEN r.summary ELSE NULL END AS summary,
			        r.cost_micros, r.created_at,
			        CASE WHEN r.mailbox_user_id = ? THEN e.subject ELSE NULL END AS subject
			 FROM agent_runs r
			 JOIN principals p ON p.id = r.agent_principal_id
			 LEFT JOIN emails e ON e.id = r.email_id
			 WHERE r.workspace_id = ?
			 ORDER BY r.created_at DESC
			 LIMIT ?`
		)
		.bind(userId, userId, human.workspace_id, limit)
		.all<{
			id: string;
			agent_principal_id: string;
			display_name: string;
			trigger_kind: TriggerKind;
			email_id: string;
			status: RunStatus;
			outcome: string | null;
			summary: string | null;
			cost_micros: number;
			created_at: string;
			subject: string | null;
		}>();
	return results.map((row) => ({
		id: row.id,
		agentId: row.agent_principal_id,
		agentName: row.display_name,
		triggerKind: row.trigger_kind,
		emailId: row.email_id,
		subject: row.subject,
		status: row.status,
		outcome: row.outcome,
		summary: row.summary,
		costMicros: row.cost_micros,
		createdAt: row.created_at
	}));
}

/** Each agent's spend this month, in micro-dollars. */
export async function spendByAgent(db: D1Database, userId: string, now = new Date()): Promise<Record<string, number>> {
	const human = await humanPrincipalForUser(db, userId);
	const { results } = await db
		.prepare(
			`SELECT agent_principal_id, SUM(cost_micros) AS spent FROM agent_runs
			 WHERE workspace_id = ? AND created_at >= ? GROUP BY agent_principal_id`
		)
		.bind(human.workspace_id, monthStart(now))
		.all<{ agent_principal_id: string; spent: number }>();
	return Object.fromEntries(results.map((row) => [row.agent_principal_id, row.spent]));
}

export type ShadowAction = {
	id: string;
	agentId: string;
	agentName: string;
	capability: string;
	payload: unknown;
	/** The thread is in someone else's mailbox, so its content isn't shown. */
	hidden: boolean;
	reason: string;
	status: 'shadowed' | 'auto_approved';
	feedback: 'up' | 'down' | null;
	createdAt: string;
};

/**
 * What agents would have done (shadow mode), and what they were allowed to do
 * on their own, newest first (A8). Nothing in this list has been carried out.
 * Content from a thread in someone else's mailbox is left out.
 */
export async function listShadowActions(db: D1Database, userId: string, limit = 30): Promise<ShadowAction[]> {
	const human = await humanPrincipalForUser(db, userId);
	const { results } = await db
		.prepare(
			`SELECT x.id, x.agent_principal_id, p.display_name, x.capability, x.status, x.feedback, x.created_at,
			        CASE WHEN x.mailbox_user_id IS NULL OR x.mailbox_user_id = ? THEN x.payload_json ELSE NULL END AS payload_json,
			        CASE WHEN x.mailbox_user_id IS NULL OR x.mailbox_user_id = ? THEN x.reason ELSE '' END AS reason
			 FROM agent_actions x
			 JOIN principals p ON p.id = x.agent_principal_id
			 WHERE x.workspace_id = ? AND x.status IN ('shadowed', 'auto_approved')
			 ORDER BY x.created_at DESC
			 LIMIT ?`
		)
		.bind(userId, userId, human.workspace_id, limit)
		.all<{
			id: string;
			agent_principal_id: string;
			display_name: string;
			capability: string;
			payload_json: string | null;
			reason: string;
			status: 'shadowed' | 'auto_approved';
			feedback: 'up' | 'down' | null;
			created_at: string;
		}>();
	return results.map((row) => ({
		id: row.id,
		agentId: row.agent_principal_id,
		agentName: row.display_name,
		capability: row.capability,
		payload: row.payload_json === null ? null : JSON.parse(row.payload_json),
		hidden: row.payload_json === null,
		reason: row.reason,
		status: row.status,
		feedback: row.feedback,
		createdAt: row.created_at
	}));
}

/** A thumbs up or down on a proposal (A8). Anyone in the workspace may say what they think. */
export async function setActionFeedback(
	db: D1Database,
	input: { actionId: string; byUserId: string; feedback: 'up' | 'down' | null }
): Promise<void> {
	const human = await humanPrincipalForUser(db, input.byUserId);
	const result = await db
		.prepare(`UPDATE agent_actions SET feedback = ? WHERE id = ? AND workspace_id = ?`)
		.bind(input.feedback, input.actionId, human.workspace_id)
		.run();
	if (!result.meta.changes) throw new AgentNotFoundError();
}

/** Agents this user may ask for help on a thread: ones they manage that aren't paused. */
export async function askableAgents(
	db: D1Database,
	userId: string
): Promise<Array<{ id: string; name: string; status: AgentStatus }>> {
	const human = await humanPrincipalForUser(db, userId);
	const { results } = await db
		.prepare(
			`SELECT p.id, p.display_name, p.owner_principal_id, a.status FROM principals p
			 JOIN agents a ON a.principal_id = p.id
			 WHERE p.workspace_id = ? AND p.kind = 'agent' AND a.status != 'paused'
			 ORDER BY p.created_at ASC`
		)
		.bind(human.workspace_id)
		.all<{ id: string; display_name: string; owner_principal_id: string | null; status: AgentStatus }>();
	return results
		.filter((row) => canManage({ ownerPrincipalId: row.owner_principal_id }, human))
		.map((row) => ({ id: row.id, name: row.display_name, status: row.status }));
}
