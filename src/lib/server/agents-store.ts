import type { D1Database } from '@cloudflare/workers-types';
import { AgentDefinitionError, parseDefinition, type AgentDefinition } from '$lib/agents/definition';
import type { Capability } from '$lib/agents/capabilities';
import {
	authorize,
	type AgentRuntime,
	type AgentStatus,
	type PolicyDecision,
	type Proposal
} from '$lib/agents/policy';

/**
 * Agents, their versioned definitions, and the log of everything they propose
 * (docs/specs/agent-staff-platform.md, A1, A3, A6–A8). Every proposal goes
 * through `authorize` before anything is recorded as allowed.
 */

export type AgentRecord = {
	id: string;
	workspaceId: string;
	displayName: string;
	ownerPrincipalId: string | null;
	status: AgentStatus;
	runtime: AgentRuntime;
	shadowRemaining: number;
	version: { id: string; number: number; definition: AgentDefinition; createdByPrincipalId: string | null };
};

export type ActionStatus =
	| 'queued'
	| 'auto_approved'
	| 'shadowed'
	| 'rejected'
	| 'approved'
	| 'declined'
	| 'expired'
	| 'executed';

export class AgentNotFoundError extends Error {
	readonly status = 404;

	constructor() {
		super('Not found');
		this.name = 'AgentNotFoundError';
	}
}

/** Only a human in the agent's workspace may hire, change, or approve for it. */
export class NotAllowedError extends Error {
	readonly status = 403;

	constructor() {
		super('Not allowed');
		this.name = 'NotAllowedError';
	}
}

/** The action isn't in a state that allows this (already decided, expired, …). */
export class ActionStateError extends Error {
	readonly status = 409;

	constructor(readonly current: ActionStatus | 'missing') {
		super(`Action is ${current}`);
		this.name = 'ActionStateError';
	}
}

/** Proposals a new agent makes in shadow mode before it can act (A8). Matches the migration default. */
export const SHADOW_PROPOSALS = 20;
const MAX_PAYLOAD_BYTES = 64 * 1024;
/** Statuses that count toward a daily limit: the action was allowed to run. */
const COUNTED_STATUSES = `('auto_approved', 'approved', 'executed')`;
const MAX_REASON_LENGTH = 2000;
const STATUS_FOR_OUTCOME: Record<PolicyDecision['outcome'], ActionStatus> = {
	execute: 'auto_approved',
	queue: 'queued',
	shadow: 'shadowed',
	reject: 'rejected'
};

type HumanPrincipal = { id: string; workspace_id: string; user_id: string; is_admin: number };

async function humanPrincipalForUser(db: D1Database, userId: string): Promise<HumanPrincipal> {
	const row = await db
		.prepare(
			`SELECT p.id, p.workspace_id, p.user_id, u.is_admin
			 FROM principals p JOIN users u ON u.id = p.user_id
			 WHERE p.user_id = ? AND p.kind = 'human'`
		)
		.bind(userId)
		.first<HumanPrincipal>();
	if (!row) throw new NotAllowedError();
	return row;
}

/** Addresses still owned by a human in the workspace. An agent can only send as one of these. */
async function liveWorkspaceAddresses(db: D1Database, workspaceId: string): Promise<Map<string, string>> {
	const { results } = await db
		.prepare(
			`SELECT LOWER(ad.address) AS address, ad.user_id FROM addresses ad
			 JOIN principals p ON p.user_id = ad.user_id
			 WHERE p.workspace_id = ? AND p.kind = 'human'`
		)
		.bind(workspaceId)
		.all<{ address: string; user_id: string }>();
	return new Map(results.map((row) => [row.address, row.user_id]));
}

/**
 * Addresses the author of an agent's current definition may still hand to it:
 * their own addresses as of now, or every human's if they are still an admin.
 * Checked on every proposal, so reassigning an address, demoting the author,
 * or deleting their account takes effect at once. Empty if the author is gone.
 */
async function sendableForAuthor(
	db: D1Database,
	workspaceId: string,
	workspaceAddresses: Map<string, string>,
	authorPrincipalId: string | null
): Promise<string[]> {
	if (!authorPrincipalId) return [];
	const author = await db
		.prepare(
			`SELECT p.user_id, u.is_admin FROM principals p JOIN users u ON u.id = p.user_id
			 WHERE p.id = ? AND p.kind = 'human' AND p.workspace_id = ?`
		)
		.bind(authorPrincipalId, workspaceId)
		.first<{ user_id: string; is_admin: number }>();
	if (!author) return [];
	return [...workspaceAddresses]
		.filter(([, owner]) => author.is_admin === 1 || owner === author.user_id)
		.map(([address]) => address);
}

/**
 * Whoever hires or edits an agent can only let it send as addresses they could
 * send as themselves: their own, or, for an admin, any human's address in the
 * workspace. Addresses already went through the claiming rules (reserved role
 * addresses are admin-only) when they were created.
 */
async function assertSendAsAllowed(db: D1Database, human: HumanPrincipal, definition: AgentDefinition) {
	if (definition.scope.sendAs.length === 0) return;
	const owned = await liveWorkspaceAddresses(db, human.workspace_id);
	for (const address of definition.scope.sendAs) {
		const owner = owned.get(address);
		if (!owner || (owner !== human.user_id && human.is_admin !== 1)) {
			throw new AgentDefinitionError('send_as');
		}
	}
}

export async function createAgent(
	db: D1Database,
	input: { ownerUserId: string; displayName: string; definition: unknown; runtime?: AgentRuntime },
	now = new Date()
): Promise<AgentRecord> {
	const owner = await humanPrincipalForUser(db, input.ownerUserId);
	const definition = parseDefinition(input.definition);
	await assertSendAsAllowed(db, owner, definition);
	const displayName = input.displayName.trim();
	if (!displayName || displayName.length > 80) throw new Error('Enter a name for the agent');

	const id = `a_${crypto.randomUUID()}`;
	const versionId = crypto.randomUUID();
	const stamp = now.toISOString();
	await db.batch([
		db
			.prepare(
				`INSERT INTO principals (id, workspace_id, kind, display_name, owner_principal_id, created_at)
				 VALUES (?, ?, 'agent', ?, ?, ?)`
			)
			.bind(id, owner.workspace_id, displayName, owner.id, stamp),
		db
			.prepare(
				`INSERT INTO agents (principal_id, status, runtime, current_version_id, created_at)
				 VALUES (?, 'shadow', ?, ?, ?)`
			)
			.bind(id, input.runtime ?? 'builtin', versionId, stamp),
		db
			.prepare(
				`INSERT INTO agent_versions (id, agent_principal_id, version, definition_json, created_by_principal_id, created_at)
				 VALUES (?, ?, 1, ?, ?, ?)`
			)
			.bind(versionId, id, JSON.stringify(definition), owner.id, stamp)
	]);

	const agent = await getAgent(db, id);
	if (!agent) throw new Error('Failed to create agent');
	return agent;
}

type AgentRow = {
	id: string;
	workspace_id: string;
	display_name: string;
	owner_principal_id: string | null;
	status: AgentStatus;
	runtime: AgentRuntime;
	shadow_remaining: number;
	version_id: string;
	version_created_by: string | null;
	version: number;
	definition_json: string;
};

export async function getAgent(db: D1Database, agentId: string): Promise<AgentRecord | null> {
	const row = await db
		.prepare(
			`SELECT p.id, p.workspace_id, p.display_name, p.owner_principal_id,
			        a.status, a.runtime, a.shadow_remaining,
			        v.id AS version_id, v.created_by_principal_id AS version_created_by, v.version, v.definition_json
			 FROM principals p
			 JOIN agents a ON a.principal_id = p.id
			 JOIN agent_versions v ON v.id = a.current_version_id
			 WHERE p.id = ? AND p.kind = 'agent'`
		)
		.bind(agentId)
		.first<AgentRow>();
	if (!row) return null;

	return {
		id: row.id,
		workspaceId: row.workspace_id,
		displayName: row.display_name,
		ownerPrincipalId: row.owner_principal_id,
		status: row.status,
		runtime: row.runtime,
		shadowRemaining: row.shadow_remaining,
		version: {
			id: row.version_id,
			number: row.version,
			definition: parseDefinition(JSON.parse(row.definition_json)),
			createdByPrincipalId: row.version_created_by
		}
	};
}

async function requireAgentForUser(db: D1Database, agentId: string, userId: string) {
	const [agent, human] = await Promise.all([getAgent(db, agentId), humanPrincipalForUser(db, userId)]);
	if (!agent) throw new AgentNotFoundError();
	if (agent.workspaceId !== human.workspace_id) throw new AgentNotFoundError();
	return { agent, human };
}

/** Saves a new version and makes it current. Old versions stay for audit and rollback. */
export async function updateAgentDefinition(
	db: D1Database,
	input: { agentId: string; byUserId: string; definition: unknown },
	now = new Date()
): Promise<AgentRecord> {
	const { agent, human } = await requireAgentForUser(db, input.agentId, input.byUserId);
	const definition = parseDefinition(input.definition);
	await assertSendAsAllowed(db, human, definition);
	const versionId = crypto.randomUUID();

	await db.batch([
		db
			.prepare(
				`INSERT INTO agent_versions (id, agent_principal_id, version, definition_json, created_by_principal_id, created_at)
				 SELECT ?, ?, COALESCE(MAX(version), 0) + 1, ?, ?, ? FROM agent_versions WHERE agent_principal_id = ?`
			)
			.bind(versionId, agent.id, JSON.stringify(definition), human.id, now.toISOString(), agent.id),
		db.prepare(`UPDATE agents SET current_version_id = ? WHERE principal_id = ?`).bind(versionId, agent.id)
	]);

	const updated = await getAgent(db, agent.id);
	if (!updated) throw new AgentNotFoundError();
	return updated;
}

/** Pause, resume, or end shadow mode early (A8, A10). */
export async function setAgentStatus(
	db: D1Database,
	input: { agentId: string; byUserId: string; status: AgentStatus }
): Promise<void> {
	const { agent } = await requireAgentForUser(db, input.agentId, input.byUserId);
	// Going back into shadow mode starts a fresh run of shadowed proposals.
	await db
		.prepare(
			`UPDATE agents
			 SET status = ?, shadow_remaining = CASE WHEN ? = 'shadow' THEN ? ELSE shadow_remaining END
			 WHERE principal_id = ?`
		)
		.bind(input.status, input.status, SHADOW_PROPOSALS, agent.id)
		.run();
}

export type ProposeInput = {
	agentId: string;
	proposal: Proposal;
	threadId?: string;
	payload: unknown;
	reason?: string;
	/** Addresses already on the thread. Supplied by the caller until threads track it (Phase 1). */
	threadParticipants?: string[];
	threadTakenOver?: boolean;
	expiresAt?: Date;
};

export type ProposeResult = { actionId: string; decision: PolicyDecision };

/**
 * Records a proposal and the policy decision on it. `auto_approved` means the
 * caller may now carry the action out and then call `markExecuted`; nothing
 * else may run.
 */
export async function proposeAction(db: D1Database, input: ProposeInput, now = new Date()): Promise<ProposeResult> {
	const agent = await getAgent(db, input.agentId);
	if (!agent) throw new AgentNotFoundError();

	const payloadJson = JSON.stringify(input.payload ?? null);
	if (new TextEncoder().encode(payloadJson).length > MAX_PAYLOAD_BYTES) {
		throw new Error('Proposal payload is too large');
	}

	const capability = input.proposal.capability;
	const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
	const [workspaceAddresses, usage] = await Promise.all([
		liveWorkspaceAddresses(db, agent.workspaceId),
		db
			.prepare(
				`SELECT
				   SUM(CASE WHEN status IN ${COUNTED_STATUSES} AND created_at >= ? THEN 1 ELSE 0 END) AS used_today,
				   SUM(CASE WHEN status IN ('approved', 'executed') AND decided_by_principal_id IS NOT NULL THEN 1 ELSE 0 END) AS approvals
				 FROM agent_actions WHERE agent_principal_id = ? AND capability = ?`
			)
			.bind(dayStart, agent.id, capability)
			.first<{ used_today: number | null; approvals: number | null }>()
	]);
	const humanAddresses = [...workspaceAddresses.keys()];
	const sendable = await sendableForAuthor(db, agent.workspaceId, workspaceAddresses, agent.version.createdByPrincipalId);

	let decision = authorize(input.proposal, {
		status: agent.status,
		runtime: agent.runtime,
		definition: agent.version.definition,
		threadParticipants: input.threadParticipants ?? [],
		founderAddresses: humanAddresses,
		sendableAddresses: sendable,
		usedToday: usage?.used_today ?? 0,
		humanApprovals: usage?.approvals ?? 0,
		threadTakenOver: input.threadTakenOver
	});

	// The count above is only a fast path. Concurrent proposals could all read
	// the same count, so the insert re-counts and turns itself into a refusal if
	// the limit filled up in the meantime (one statement, so it is atomic).
	// `execute` means authorize() already confirmed this is a catalog capability.
	const limit =
		decision.outcome === 'execute'
			? agent.version.definition.capabilities[capability as Capability]?.dailyLimit
			: undefined;
	const status = STATUS_FOR_OUTCOME[decision.outcome];
	const authorized = decision.outcome === 'reject' ? null : JSON.stringify(decision.addresses);

	const actionId = crypto.randomUUID();
	const statements = [
		db
			.prepare(
				`INSERT INTO agent_actions
				 (id, workspace_id, agent_principal_id, version_id, capability, thread_id, payload_json, authorized_json,
				  reason, status, policy_reason, expires_at, created_at)
				 SELECT ?, ?, ?, ?, ?, ?, ?,
				        CASE WHEN within_limit THEN ? ELSE NULL END,
				        ?,
				        CASE WHEN within_limit THEN ? ELSE 'rejected' END,
				        CASE WHEN within_limit THEN ? ELSE 'daily_limit_reached' END,
				        ?, ?
				 FROM (SELECT (? IS NULL OR (
				         SELECT COUNT(*) FROM agent_actions
				         WHERE agent_principal_id = ? AND capability = ? AND status IN ${COUNTED_STATUSES} AND created_at >= ?
				       ) < ?) AS within_limit)`
			)
			.bind(
				actionId,
				agent.workspaceId,
				agent.id,
				agent.version.id,
				capability.slice(0, 64),
				input.threadId ?? null,
				payloadJson,
				authorized,
				(input.reason ?? '').slice(0, MAX_REASON_LENGTH),
				status,
				decision.reason,
				input.expiresAt?.toISOString() ?? null,
				now.toISOString(),
				limit ?? null,
				agent.id,
				capability,
				dayStart,
				limit ?? null
			)
	];
	if (decision.outcome === 'shadow') {
		// Shadow mode ends on its own after enough proposals (A8).
		statements.push(
			db
				.prepare(
					`UPDATE agents
					 SET status = CASE WHEN shadow_remaining <= 1 THEN 'active' ELSE status END,
					     shadow_remaining = MAX(shadow_remaining - 1, 0)
					 WHERE principal_id = ? AND status = 'shadow'`
				)
				.bind(agent.id)
		);
	}
	await db.batch(statements);

	if (limit !== undefined) {
		const row = await db
			.prepare(`SELECT status FROM agent_actions WHERE id = ?`)
			.bind(actionId)
			.first<{ status: ActionStatus }>();
		if (row?.status === 'rejected') decision = { outcome: 'reject', reason: 'daily_limit_reached' };
	}

	return { actionId, decision };
}

type ActionRow = { id: string; workspace_id: string; status: ActionStatus; expires_at: string | null };

/** A human approves or declines a queued proposal (A7). */
export async function decideAction(
	db: D1Database,
	input: { actionId: string; byUserId: string; decision: 'approve' | 'decline'; note?: string; edited?: boolean },
	now = new Date()
): Promise<ActionStatus> {
	const human = await humanPrincipalForUser(db, input.byUserId);
	const action = await db
		.prepare(`SELECT id, workspace_id, status, expires_at FROM agent_actions WHERE id = ?`)
		.bind(input.actionId)
		.first<ActionRow>();
	if (!action || action.workspace_id !== human.workspace_id) throw new ActionStateError('missing');
	if (action.status !== 'queued') throw new ActionStateError(action.status);
	if (action.expires_at && action.expires_at <= now.toISOString()) {
		await expireActions(db, now);
		throw new ActionStateError('expired');
	}

	const status: ActionStatus = input.decision === 'approve' ? 'approved' : 'declined';
	const result = await db
		.prepare(
			`UPDATE agent_actions
			 SET status = ?, decided_by_principal_id = ?, decision_note = ?, edited = ?, decided_at = ?
			 WHERE id = ? AND status = 'queued'`
		)
		.bind(
			status,
			human.id,
			input.note?.slice(0, MAX_REASON_LENGTH) ?? null,
			input.edited ? 1 : 0,
			now.toISOString(),
			action.id
		)
		.run();
	if (!result.meta.changes) {
		// Someone else decided between our read and this write.
		const row = await db
			.prepare(`SELECT status FROM agent_actions WHERE id = ?`)
			.bind(action.id)
			.first<{ status: ActionStatus }>();
		throw new ActionStateError(row?.status ?? 'missing');
	}
	return status;
}

/** Queued proposals past their expiry are never sent late (story 16). Returns how many expired. */
export async function expireActions(db: D1Database, now = new Date()): Promise<number> {
	const result = await db
		.prepare(
			`UPDATE agent_actions SET status = 'expired', decided_at = ?
			 WHERE status = 'queued' AND expires_at IS NOT NULL AND expires_at <= ?`
		)
		.bind(now.toISOString(), now.toISOString())
		.run();
	return result.meta.changes ?? 0;
}

/** The effect happened. Only allowed actions can be marked, and only once. */
export async function markExecuted(db: D1Database, actionId: string, now = new Date()): Promise<void> {
	const result = await db
		.prepare(
			`UPDATE agent_actions SET status = 'executed', executed_at = ?
			 WHERE id = ? AND status IN ('auto_approved', 'approved')`
		)
		.bind(now.toISOString(), actionId)
		.run();
	if (!result.meta.changes) {
		const row = await db
			.prepare(`SELECT status FROM agent_actions WHERE id = ?`)
			.bind(actionId)
			.first<{ status: ActionStatus }>();
		throw new ActionStateError(row?.status ?? 'missing');
	}
}

export type QueuedAction = {
	id: string;
	agentId: string;
	agentName: string;
	capability: string;
	threadId: string | null;
	payload: unknown;
	reason: string;
	createdAt: string;
	expiresAt: string | null;
};

/** The Needs your OK queue for a user's workspace, oldest first. */
export async function listQueuedActions(db: D1Database, userId: string, now = new Date()): Promise<QueuedAction[]> {
	const human = await humanPrincipalForUser(db, userId);
	await expireActions(db, now);
	const { results } = await db
		.prepare(
			`SELECT x.id, x.agent_principal_id, p.display_name, x.capability, x.thread_id,
			        x.payload_json, x.reason, x.created_at, x.expires_at
			 FROM agent_actions x JOIN principals p ON p.id = x.agent_principal_id
			 WHERE x.workspace_id = ? AND x.status = 'queued'
			 ORDER BY x.created_at ASC`
		)
		.bind(human.workspace_id)
		.all<{
			id: string;
			agent_principal_id: string;
			display_name: string;
			capability: string;
			thread_id: string | null;
			payload_json: string;
			reason: string;
			created_at: string;
			expires_at: string | null;
		}>();

	return results.map((row) => ({
		id: row.id,
		agentId: row.agent_principal_id,
		agentName: row.display_name,
		capability: row.capability,
		threadId: row.thread_id,
		payload: JSON.parse(row.payload_json),
		reason: row.reason,
		createdAt: row.created_at,
		expiresAt: row.expires_at
	}));
}
