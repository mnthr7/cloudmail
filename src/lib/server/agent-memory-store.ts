import type { D1Database } from '@cloudflare/workers-types';
import { AgentNotFoundError, NotAllowedError, canManage, getAgent, humanPrincipalForUser } from './agents-store.ts';

/**
 * What an agent remembers (docs/specs/agent-staff-platform.md, A9): a short
 * list of facts, all visible and editable on its page. Only humans put facts
 * here, by hand, by "@agent remember: ...", or by approving an agent's proposal.
 * Mail can't: an email asking an agent to remember something is just data.
 */

export const MAX_FACTS = 50;
export const MAX_FACT_LENGTH = 300;

export type MemoryFact = {
	id: string;
	fact: string;
	source: 'founder' | 'agent';
	addedBy: string | null;
	createdAt: string;
};

export class MemoryError extends Error {
	readonly status = 400;

	constructor(readonly code: 'fact' | 'full' | 'missing') {
		super(code);
		this.name = 'MemoryError';
	}
}

function cleanFact(value: unknown): string {
	const fact = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
	if (!fact || fact.length > MAX_FACT_LENGTH) throw new MemoryError('fact');
	return fact;
}

export async function listMemory(db: D1Database, agentId: string): Promise<MemoryFact[]> {
	const { results } = await db
		.prepare(
			`SELECT m.id, m.fact, m.source, p.display_name AS added_by, m.created_at
			 FROM agent_memory m LEFT JOIN principals p ON p.id = m.added_by_principal_id
			 WHERE m.agent_principal_id = ?
			 ORDER BY m.created_at ASC, m.id ASC`
		)
		.bind(agentId)
		.all<{ id: string; fact: string; source: 'founder' | 'agent'; added_by: string | null; created_at: string }>();
	return results.map((row) => ({
		id: row.id,
		fact: row.fact,
		source: row.source,
		addedBy: row.added_by,
		createdAt: row.created_at
	}));
}

/** Memory for every agent this user can see, for the Staff page. */
export async function memoryByAgent(db: D1Database, agentIds: string[]): Promise<Record<string, MemoryFact[]>> {
	const out: Record<string, MemoryFact[]> = {};
	for (const id of agentIds) out[id] = await listMemory(db, id);
	return out;
}

/**
 * Adds a fact. `byUserId` is the human: they must be able to change the agent.
 * For an approved agent proposal the executor passes the approver's principal.
 */
export async function addMemory(
	db: D1Database,
	input: {
		agentId: string;
		fact: unknown;
		source: 'founder' | 'agent';
		/** A human who may change the agent. Required for founder facts. */
		byUserId?: string;
		/** Set when an approved proposal adds it. */
		byPrincipalId?: string | null;
		actionId?: string | null;
	},
	now = new Date()
): Promise<MemoryFact> {
	const fact = cleanFact(input.fact);
	const agent = await getAgent(db, input.agentId);
	if (!agent) throw new AgentNotFoundError();
	let byPrincipalId = input.byPrincipalId ?? null;
	if (input.byUserId) {
		const human = await humanPrincipalForUser(db, input.byUserId);
		if (human.workspace_id !== agent.workspaceId) throw new AgentNotFoundError();
		if (!canManage(agent, human)) throw new NotAllowedError();
		byPrincipalId = human.id;
	} else if (input.source === 'founder') {
		throw new NotAllowedError();
	}

	const count = await db
		.prepare(`SELECT COUNT(*) AS n FROM agent_memory WHERE agent_principal_id = ?`)
		.bind(agent.id)
		.first<{ n: number }>();
	if ((count?.n ?? 0) >= MAX_FACTS) throw new MemoryError('full');

	const id = crypto.randomUUID();
	const at = now.toISOString();
	await db
		.prepare(
			`INSERT INTO agent_memory (id, agent_principal_id, fact, source, added_by_principal_id, action_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(id, agent.id, fact, input.source, byPrincipalId, input.actionId ?? null, at, at)
		.run();
	return { id, fact, source: input.source, addedBy: null, createdAt: at };
}

async function requireManager(db: D1Database, agentId: string, userId: string) {
	const [agent, human] = await Promise.all([getAgent(db, agentId), humanPrincipalForUser(db, userId)]);
	if (!agent || agent.workspaceId !== human.workspace_id) throw new AgentNotFoundError();
	if (!canManage(agent, human)) throw new NotAllowedError();
	return agent;
}

export async function updateMemory(
	db: D1Database,
	input: { agentId: string; factId: string; fact: unknown; byUserId: string },
	now = new Date()
): Promise<void> {
	const fact = cleanFact(input.fact);
	await requireManager(db, input.agentId, input.byUserId);
	const result = await db
		.prepare(`UPDATE agent_memory SET fact = ?, updated_at = ? WHERE id = ? AND agent_principal_id = ?`)
		.bind(fact, now.toISOString(), input.factId, input.agentId)
		.run();
	if (!result.meta.changes) throw new MemoryError('missing');
}

export async function deleteMemory(db: D1Database, input: { agentId: string; factId: string; byUserId: string }): Promise<void> {
	await requireManager(db, input.agentId, input.byUserId);
	const result = await db
		.prepare(`DELETE FROM agent_memory WHERE id = ? AND agent_principal_id = ?`)
		.bind(input.factId, input.agentId)
		.run();
	if (!result.meta.changes) throw new MemoryError('missing');
}
