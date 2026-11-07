import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { D1Database } from '@cloudflare/workers-types';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
	ActionStateError,
	AgentNotFoundError,
	NotAllowedError,
	createAgent,
	decideAction,
	expireActions,
	getAgent,
	getAgentForUser,
	listAgents,
	listQueuedActions,
	pauseAllAgents,
	sendAsChoices,
	markExecuted,
	proposeAction,
	setAgentStatus,
	updateAgentDefinition
} from '../src/lib/server/agents-store';

const MIGRATIONS = path.join(import.meta.dir, '../migrations');
const AGENT_MIGRATION = '0015_principals_agents.sql';

/** Applies migrations in order. `until` stops before that file. */
function migrate(sqlite: Database, until?: string) {
	for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
		if (until && file >= until) break;
		sqlite.exec(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
	}
}

function adapt(sqlite: Database): D1Database {
	const statement = (sql: string, values: unknown[] = []) => ({
		sql,
		values,
		bind: (...params: unknown[]) => statement(sql, params.map((value) => (value === undefined ? null : value))),
		async first<T>() {
			return (sqlite.query(sql).get(...(values as never[])) as T) ?? null;
		},
		async all<T>() {
			return { results: sqlite.query(sql).all(...(values as never[])) as T[], success: true, meta: {} };
		},
		async run() {
			const info = sqlite.run(sql, values as never[]);
			return { success: true, meta: { changes: info.changes } };
		}
	});
	return {
		prepare: (sql: string) => statement(sql),
		// D1 runs a batch as one transaction.
		async batch(statements: Array<ReturnType<typeof statement>>) {
			return sqlite.transaction(() => statements.map((s) => sqlite.run(s.sql, s.values as never[])))();
		}
	} as unknown as D1Database;
}

function addUser(sqlite: Database, id: string, name: string, addresses: string[], isAdmin = false) {
	sqlite.run(`INSERT INTO users (id, email, name, password_hash, is_admin) VALUES (?, ?, ?, 'x', ?)`, [
		id,
		`${id}@login.test`,
		name,
		isAdmin ? 1 : 0
	]);
	sqlite.run(`INSERT OR IGNORE INTO domains (id, name) VALUES ('d1', 'acme.com')`);
	for (const address of addresses) {
		sqlite.run(`INSERT INTO addresses (id, user_id, domain_id, address) VALUES (?, ?, 'd1', ?)`, [`ad_${address}`, id, address]);
	}
}

function open() {
	const sqlite = new Database(':memory:');
	sqlite.exec('PRAGMA foreign_keys = ON');
	migrate(sqlite);
	addUser(sqlite, 'u1', 'Sada', ['sada@acme.com', 'billing@acme.com']);
	return { sqlite, db: adapt(sqlite) };
}

const billing = {
	job: 'Chase overdue invoices politely.',
	capabilities: {
		read_threads: { level: 'auto' },
		send_reply: { level: 'auto', dailyLimit: 2 },
		send_email: { level: 'approve' },
		organize: { level: 'approve' }
	},
	scope: { sendAs: ['billing@acme.com'], recipients: { kind: 'thread' } }
};

const reply = {
	capability: 'send_reply',
	fromAddress: 'billing@acme.com',
	recipients: ['client@globex.com']
};

async function activeAgent(db: D1Database) {
	const agent = await createAgent(db, { ownerUserId: 'u1', displayName: 'Billing', definition: billing });
	await setAgentStatus(db, { agentId: agent.id, byUserId: 'u1', status: 'active' });
	return agent;
}

function status(sqlite: Database, actionId: string) {
	return (sqlite.query('SELECT status FROM agent_actions WHERE id = ?').get(actionId) as { status: string }).status;
}

describe('principals migration', () => {
	test('existing users become human principals; mail tables are untouched', () => {
		const sqlite = new Database(':memory:');
		migrate(sqlite, AGENT_MIGRATION);
		sqlite.run(`INSERT INTO users (id, email, name, password_hash) VALUES ('old', 'old@login.test', 'Old', 'x')`);
		const emailColumns = sqlite.query('PRAGMA table_info(emails)').all();

		sqlite.exec(readFileSync(path.join(MIGRATIONS, AGENT_MIGRATION), 'utf8'));

		expect(sqlite.query(`SELECT id, workspace_id, kind, display_name FROM principals`).all()).toEqual([
			{ id: 'p_old', workspace_id: 'default', kind: 'human', display_name: 'Old' }
		]);
		expect(sqlite.query('PRAGMA table_info(emails)').all()).toEqual(emailColumns);
	});

	test('users created afterwards get a principal too, from any code path', () => {
		const { sqlite } = open();
		expect(sqlite.query(`SELECT id, kind FROM principals WHERE user_id = 'u1'`).get()).toEqual({ id: 'p_u1', kind: 'human' });
	});

	test('re-running the migration changes nothing', () => {
		const { sqlite } = open();
		sqlite.exec(readFileSync(path.join(MIGRATIONS, AGENT_MIGRATION), 'utf8'));
		expect(sqlite.query('SELECT COUNT(*) AS n FROM principals').get()).toEqual({ n: 1 });
	});

	test('a principal must be a human with a user, or an agent without one', () => {
		const { sqlite } = open();
		expect(() =>
			sqlite.run(`INSERT INTO principals (id, workspace_id, kind, display_name) VALUES ('x', 'default', 'human', 'X')`)
		).toThrow();
		expect(() =>
			sqlite.run(`INSERT INTO principals (id, workspace_id, kind, user_id, display_name) VALUES ('y', 'default', 'agent', 'u1', 'Y')`)
		).toThrow();
	});

	test('deleting a user removes their principal', () => {
		const { sqlite } = open();
		sqlite.run(`DELETE FROM users WHERE id = 'u1'`);
		expect(sqlite.query('SELECT COUNT(*) AS n FROM principals').get()).toEqual({ n: 0 });
	});
});

describe('hiring and changing agents', () => {
	test('a new agent starts in shadow mode at version 1, owned by its hirer', async () => {
		const { db } = open();
		const agent = await createAgent(db, { ownerUserId: 'u1', displayName: 'Billing', definition: billing });
		expect(agent).toMatchObject({
			workspaceId: 'default',
			displayName: 'Billing',
			ownerPrincipalId: 'p_u1',
			status: 'shadow',
			runtime: 'builtin',
			shadowRemaining: 20,
			version: { number: 1 }
		});
	});

	test('only a human principal can hire', async () => {
		const { db } = open();
		await expect(createAgent(db, { ownerUserId: 'nobody', displayName: 'X', definition: billing })).rejects.toBeInstanceOf(
			NotAllowedError
		);
	});

	test('changing a definition saves a new version and keeps the old one', async () => {
		const { sqlite, db } = open();
		const agent = await createAgent(db, { ownerUserId: 'u1', displayName: 'Billing', definition: billing });
		const updated = await updateAgentDefinition(db, {
			agentId: agent.id,
			byUserId: 'u1',
			definition: { ...billing, job: 'Chase invoices over 14 days.' }
		});
		expect(updated.version.number).toBe(2);
		expect(updated.version.definition.job).toBe('Chase invoices over 14 days.');
		expect(sqlite.query('SELECT COUNT(*) AS n FROM agent_versions WHERE agent_principal_id = ?').get(agent.id)).toEqual({ n: 2 });
	});

	test('an invalid definition is refused and nothing is saved', async () => {
		const { sqlite, db } = open();
		const bad = { ...billing, capabilities: { hire_agent: { level: 'auto' } } };
		await expect(createAgent(db, { ownerUserId: 'u1', displayName: 'X', definition: bad })).rejects.toThrow();
		expect(sqlite.query(`SELECT COUNT(*) AS n FROM principals WHERE kind = 'agent'`).get()).toEqual({ n: 0 });
	});

	test('unknown agents are not found', async () => {
		const { db } = open();
		expect(await getAgent(db, 'a_missing')).toBeNull();
		await expect(proposeAction(db, { agentId: 'a_missing', proposal: reply, payload: {} })).rejects.toBeInstanceOf(
			AgentNotFoundError
		);
	});
});

describe('who an agent may send as', () => {
	test("a non-admin can't let an agent send as someone else's address", async () => {
		const { sqlite, db } = open();
		addUser(sqlite, 'u2', 'Priya', ['priya@acme.com']);
		let error: unknown;
		try {
			await createAgent(db, { ownerUserId: 'u2', displayName: 'Billing', definition: billing });
		} catch (caught) {
			error = caught;
		}
		expect(error).toMatchObject({ code: 'send_as' });
	});

	test("an address that doesn't exist at all is refused", async () => {
		const { db } = open();
		const def = { ...billing, scope: { ...billing.scope, sendAs: ['ceo@acme.com'] } };
		await expect(createAgent(db, { ownerUserId: 'u1', displayName: 'X', definition: def })).rejects.toMatchObject({ code: 'send_as' });
	});

	test("an admin may let an agent send as another human's address", async () => {
		const { sqlite, db } = open();
		addUser(sqlite, 'u2', 'Priya', ['priya@acme.com'], true);
		const agent = await createAgent(db, { ownerUserId: 'u2', displayName: 'Billing', definition: billing });
		expect(agent.version.definition.scope.sendAs).toEqual(['billing@acme.com']);
	});

	test('the same check applies when a definition is edited', async () => {
		const { sqlite, db } = open();
		addUser(sqlite, 'u2', 'Priya', ['priya@acme.com']);
		const agent = await createAgent(db, { ownerUserId: 'u1', displayName: 'Billing', definition: billing });
		const def = { ...billing, scope: { ...billing.scope, sendAs: ['priya@acme.com'] } };
		await expect(updateAgentDefinition(db, { agentId: agent.id, byUserId: 'u1', definition: def })).rejects.toMatchObject({
			code: 'send_as'
		});
	});

	test('moving the address to another user stops the agent sending as it', async () => {
		const { sqlite, db } = open();
		addUser(sqlite, 'u2', 'Priya', ['priya@acme.com']);
		const agent = await activeAgent(db);
		sqlite.run(`UPDATE addresses SET user_id = 'u2' WHERE address = 'billing@acme.com'`);
		const result = await proposeAction(db, { agentId: agent.id, proposal: reply, payload: {}, threadParticipants: ['client@globex.com'] });
		expect(result.decision).toEqual({ outcome: 'reject', reason: 'send_as_out_of_scope' });
	});

	test("an admin's grant of someone else's address ends when they stop being an admin", async () => {
		const { sqlite, db } = open();
		addUser(sqlite, 'u2', 'Priya', ['priya@acme.com'], true);
		const agent = await createAgent(db, { ownerUserId: 'u2', displayName: 'Billing', definition: billing });
		await setAgentStatus(db, { agentId: agent.id, byUserId: 'u2', status: 'active' });
		const base = { agentId: agent.id, proposal: reply, payload: {}, threadParticipants: ['client@globex.com'] };
		expect((await proposeAction(db, base)).decision.outcome).toBe('execute');

		sqlite.run(`UPDATE users SET is_admin = 0 WHERE id = 'u2'`);
		expect((await proposeAction(db, base)).decision).toEqual({ outcome: 'reject', reason: 'send_as_out_of_scope' });
	});

	test('if the author of the definition is deleted, the agent can no longer send', async () => {
		const { sqlite, db } = open();
		addUser(sqlite, 'u2', 'Priya', ['priya@acme.com'], true);
		const agent = await createAgent(db, { ownerUserId: 'u2', displayName: 'Billing', definition: billing });
		await setAgentStatus(db, { agentId: agent.id, byUserId: 'u1', status: 'active' });
		sqlite.run(`DELETE FROM users WHERE id = 'u2'`);
		const result = await proposeAction(db, { agentId: agent.id, proposal: reply, payload: {}, threadParticipants: ['client@globex.com'] });
		expect(result.decision).toEqual({ outcome: 'reject', reason: 'send_as_out_of_scope' });
	});

	test('deleting the address stops the agent sending as it straight away', async () => {
		const { sqlite, db } = open();
		const agent = await activeAgent(db);
		sqlite.run(`DELETE FROM addresses WHERE address = 'billing@acme.com'`);
		const result = await proposeAction(db, { agentId: agent.id, proposal: reply, payload: {}, threadParticipants: ['client@globex.com'] });
		expect(result.decision).toEqual({ outcome: 'reject', reason: 'send_as_out_of_scope' });
	});
});

describe('proposing actions', () => {
	test('concurrent proposals cannot overrun the daily limit', async () => {
		const { sqlite, db } = open();
		const agent = await activeAgent(db);
		const base = { agentId: agent.id, proposal: reply, payload: {}, threadParticipants: ['client@globex.com'] };
		const results = await Promise.all(Array.from({ length: 6 }, () => proposeAction(db, base)));

		expect(results.filter((r) => r.decision.outcome === 'execute')).toHaveLength(2);
		expect(results.filter((r) => r.decision.reason === 'daily_limit_reached')).toHaveLength(4);
		expect(sqlite.query(`SELECT COUNT(*) AS n FROM agent_actions WHERE status = 'auto_approved'`).get()).toEqual({ n: 2 });
	});

	test('the exact allowed addresses are stored for whatever carries the action out', async () => {
		const { sqlite, db } = open();
		const agent = await activeAgent(db);
		const { actionId } = await proposeAction(db, {
			agentId: agent.id,
			proposal: { ...reply, recipients: ['Client@Globex.com'] },
			payload: { to: 'anything the model wrote' },
			threadParticipants: ['client@globex.com']
		});
		const row = sqlite.query('SELECT authorized_json FROM agent_actions WHERE id = ?').get(actionId) as { authorized_json: string };
		expect(JSON.parse(row.authorized_json)).toEqual({ from: 'billing@acme.com', recipients: ['client@globex.com'] });
	});

	test('every proposal is recorded with the version and the policy decision', async () => {
		const { sqlite, db } = open();
		const agent = await activeAgent(db);
		const result = await proposeAction(db, {
			agentId: agent.id,
			proposal: reply,
			threadId: 't1',
			payload: { body: 'Friendly reminder…' },
			reason: 'Invoice 7 days overdue',
			threadParticipants: ['client@globex.com']
		});
		expect(result.decision).toMatchObject({ outcome: 'execute', reason: 'auto' });
		expect(
			sqlite.query('SELECT status, policy_reason, version_id, thread_id, reason FROM agent_actions WHERE id = ?').get(result.actionId)
		).toEqual({
			status: 'auto_approved',
			policy_reason: 'auto',
			version_id: agent.version.id,
			thread_id: 't1',
			reason: 'Invoice 7 days overdue'
		});
	});

	test('refusals are recorded too, so the audit trail is complete', async () => {
		const { sqlite, db } = open();
		const agent = await activeAgent(db);
		const result = await proposeAction(db, {
			agentId: agent.id,
			proposal: { ...reply, recipients: ['attacker@evil.test'] },
			payload: {},
			threadParticipants: ['client@globex.com']
		});
		expect(result.decision).toEqual({ outcome: 'reject', reason: 'recipient_out_of_scope' });
		expect(status(sqlite, result.actionId)).toBe('rejected');
	});

	test("the founder's own addresses are always allowed recipients", async () => {
		const { db } = open();
		const agent = await activeAgent(db);
		const result = await proposeAction(db, {
			agentId: agent.id,
			proposal: { ...reply, recipients: ['sada@acme.com'] },
			payload: {}
		});
		expect(result.decision.outcome).toBe('execute');
	});

	test('the daily limit counts only actions that were allowed, and resets at UTC midnight', async () => {
		const { db } = open();
		const agent = await activeAgent(db);
		const base = { agentId: agent.id, proposal: reply, payload: {}, threadParticipants: ['client@globex.com'] };
		const day = new Date('2026-11-06T10:00:00Z');

		await proposeAction(db, { ...base, proposal: { ...reply, recipients: ['attacker@evil.test'] } }, day); // rejected, not counted
		expect((await proposeAction(db, base, day)).decision.outcome).toBe('execute');
		expect((await proposeAction(db, base, day)).decision.outcome).toBe('execute');
		expect((await proposeAction(db, base, day)).decision).toEqual({ outcome: 'reject', reason: 'daily_limit_reached' });
		expect((await proposeAction(db, base, new Date('2026-11-07T00:00:01Z'))).decision.outcome).toBe('execute');
	});

	test('shadow mode ends on its own after 20 shadowed proposals', async () => {
		const { db } = open();
		const agent = await createAgent(db, { ownerUserId: 'u1', displayName: 'Billing', definition: billing });
		const base = { agentId: agent.id, proposal: { capability: 'organize' }, payload: {} };

		for (let i = 0; i < 20; i++) {
			expect((await proposeAction(db, base)).decision.outcome).toBe('shadow');
		}
		expect(await getAgent(db, agent.id)).toMatchObject({ status: 'active', shadowRemaining: 0 });
		expect((await proposeAction(db, base)).decision.outcome).toBe('queue');
	});

	test('reads and refusals do not use up shadow proposals', async () => {
		const { db } = open();
		const agent = await createAgent(db, { ownerUserId: 'u1', displayName: 'Billing', definition: billing });
		await proposeAction(db, { agentId: agent.id, proposal: { capability: 'read_threads' }, payload: {} });
		await proposeAction(db, { agentId: agent.id, proposal: { capability: 'set_timer' }, payload: {} });
		expect((await getAgent(db, agent.id))?.shadowRemaining).toBe(20);
	});

	test('putting an agent back into shadow mode starts a fresh count', async () => {
		const { db } = open();
		const agent = await activeAgent(db);
		await setAgentStatus(db, { agentId: agent.id, byUserId: 'u1', status: 'shadow' });
		expect(await getAgent(db, agent.id)).toMatchObject({ status: 'shadow', shadowRemaining: 20 });
	});

	test('a paused agent is refused, and resuming lets it work again', async () => {
		const { db } = open();
		const agent = await activeAgent(db);
		await setAgentStatus(db, { agentId: agent.id, byUserId: 'u1', status: 'paused' });
		const base = { agentId: agent.id, proposal: { capability: 'read_threads' }, payload: {} };
		expect((await proposeAction(db, base)).decision.reason).toBe('agent_paused');
		await setAgentStatus(db, { agentId: agent.id, byUserId: 'u1', status: 'active' });
		expect((await proposeAction(db, base)).decision.outcome).toBe('execute');
	});

	test('an oversized payload is refused before anything is written', async () => {
		const { sqlite, db } = open();
		const agent = await activeAgent(db);
		await expect(
			proposeAction(db, { agentId: agent.id, proposal: { capability: 'organize' }, payload: 'x'.repeat(70_000) })
		).rejects.toThrow('too large');
		expect(sqlite.query('SELECT COUNT(*) AS n FROM agent_actions').get()).toEqual({ n: 0 });
	});

	test('an external agent needs 20 human approvals before auto sends take effect', async () => {
		const { db } = open();
		const agent = await createAgent(db, { ownerUserId: 'u1', displayName: 'Research', definition: billing, runtime: 'external' });
		await setAgentStatus(db, { agentId: agent.id, byUserId: 'u1', status: 'active' });
		const def = { ...billing, capabilities: { ...billing.capabilities, send_reply: { level: 'auto' } } };
		await updateAgentDefinition(db, { agentId: agent.id, byUserId: 'u1', definition: def });
		const base = { agentId: agent.id, proposal: reply, payload: {}, threadParticipants: ['client@globex.com'] };

		for (let i = 0; i < 20; i++) {
			const { actionId, decision } = await proposeAction(db, base);
			expect(decision).toMatchObject({ outcome: 'queue', reason: 'external_track_record' });
			await decideAction(db, { actionId, byUserId: 'u1', decision: 'approve' });
		}
		expect((await proposeAction(db, base)).decision.outcome).toBe('execute');
	});
});

describe('the Needs your OK queue', () => {
	test('a human approves a queued action, which can then be marked executed once', async () => {
		const { sqlite, db } = open();
		const agent = await activeAgent(db);
		const { actionId } = await proposeAction(db, { agentId: agent.id, proposal: { capability: 'organize' }, payload: { label: 'Overdue' } });

		const queue = await listQueuedActions(db, 'u1');
		expect(queue).toHaveLength(1);
		expect(queue[0]).toMatchObject({ id: actionId, agentName: 'Billing', capability: 'organize', payload: { label: 'Overdue' } });

		expect(await decideAction(db, { actionId, byUserId: 'u1', decision: 'approve', edited: true, note: 'ok' })).toBe('approved');
		expect(sqlite.query('SELECT decided_by_principal_id, edited, decision_note FROM agent_actions WHERE id = ?').get(actionId)).toEqual({
			decided_by_principal_id: 'p_u1',
			edited: 1,
			decision_note: 'ok'
		});
		expect(await listQueuedActions(db, 'u1')).toHaveLength(0);

		await markExecuted(db, actionId);
		expect(status(sqlite, actionId)).toBe('executed');
		await expect(markExecuted(db, actionId)).rejects.toBeInstanceOf(ActionStateError);
	});

	test('declined, rejected, and shadowed actions can never be executed', async () => {
		const { db } = open();
		const agent = await activeAgent(db);
		const queued = await proposeAction(db, { agentId: agent.id, proposal: { capability: 'organize' }, payload: {} });
		await decideAction(db, { actionId: queued.actionId, byUserId: 'u1', decision: 'decline', note: 'wrong label' });
		const rejected = await proposeAction(db, { agentId: agent.id, proposal: { capability: 'set_timer' }, payload: {} });
		await setAgentStatus(db, { agentId: agent.id, byUserId: 'u1', status: 'shadow' });
		const shadowed = await proposeAction(db, { agentId: agent.id, proposal: { capability: 'organize' }, payload: {} });

		for (const { actionId } of [queued, rejected, shadowed]) {
			await expect(markExecuted(db, actionId)).rejects.toBeInstanceOf(ActionStateError);
		}
	});

	test('an action can be decided only once', async () => {
		const { db } = open();
		const agent = await activeAgent(db);
		const { actionId } = await proposeAction(db, { agentId: agent.id, proposal: { capability: 'organize' }, payload: {} });
		await decideAction(db, { actionId, byUserId: 'u1', decision: 'approve' });
		await expect(decideAction(db, { actionId, byUserId: 'u1', decision: 'decline' })).rejects.toBeInstanceOf(ActionStateError);
	});

	test('auto-approved actions are not in the queue and cannot be "approved" again', async () => {
		const { db } = open();
		const agent = await activeAgent(db);
		const { actionId } = await proposeAction(db, {
			agentId: agent.id,
			proposal: reply,
			payload: {},
			threadParticipants: ['client@globex.com']
		});
		expect(await listQueuedActions(db, 'u1')).toHaveLength(0);
		await expect(decideAction(db, { actionId, byUserId: 'u1', decision: 'approve' })).rejects.toBeInstanceOf(ActionStateError);
	});

	test('stale proposals expire instead of going out late', async () => {
		const { sqlite, db } = open();
		const agent = await activeAgent(db);
		const now = new Date('2026-11-06T10:00:00Z');
		const { actionId } = await proposeAction(
			db,
			{ agentId: agent.id, proposal: { capability: 'organize' }, payload: {}, expiresAt: new Date('2026-11-06T11:00:00Z') },
			now
		);
		const later = new Date('2026-11-06T11:00:00Z');
		await expect(decideAction(db, { actionId, byUserId: 'u1', decision: 'approve' }, later)).rejects.toMatchObject({
			current: 'expired'
		});
		expect(status(sqlite, actionId)).toBe('expired');
		expect(await expireActions(db, later)).toBe(0);
	});

	test('only a signed-in human can decide', async () => {
		const { db } = open();
		const agent = await activeAgent(db);
		const { actionId } = await proposeAction(db, { agentId: agent.id, proposal: { capability: 'organize' }, payload: {} });
		await expect(decideAction(db, { actionId, byUserId: 'nobody', decision: 'approve' })).rejects.toBeInstanceOf(NotAllowedError);
		await expect(setAgentStatus(db, { agentId: agent.id, byUserId: 'nobody', status: 'active' })).rejects.toBeInstanceOf(
			NotAllowedError
		);
	});
});

describe('the Staff page', () => {
	const email = { capability: 'send_email', fromAddress: 'billing@acme.com', recipients: ['client@globex.com'] };

	test('lists every agent in the workspace with what is waiting for a human', async () => {
		const { db } = open();
		const agent = await activeAgent(db);
		await createAgent(db, { ownerUserId: 'u1', displayName: 'Scout', definition: { ...billing, scope: { sendAs: [], recipients: { kind: 'thread' } } } });
		const now = new Date('2026-11-07T12:00:00Z');
		await proposeAction(db, { agentId: agent.id, proposal: email, payload: {}, threadParticipants: ['client@globex.com'] }, now);
		await proposeAction(
			db,
			{
				agentId: agent.id,
				proposal: email,
				payload: {},
				threadParticipants: ['client@globex.com'],
				expiresAt: new Date('2026-11-07T12:30:00Z')
			},
			now
		);

		const agents = await listAgents(db, 'u1', new Date('2026-11-07T13:00:00Z'));
		expect(agents.map((item) => [item.displayName, item.status, item.queued])).toEqual([
			['Billing', 'active', 1],
			['Scout', 'shadow', 0]
		]);
		expect(agents[0].versionNumber).toBe(1);
		expect(agents[0].definition.scope.sendAs).toEqual(['billing@acme.com']);
	});

	test("does not show another workspace's agents", async () => {
		const { sqlite, db } = open();
		await activeAgent(db);
		sqlite.run(`INSERT INTO workspaces (id, name) VALUES ('w2', 'Other')`);
		addUser(sqlite, 'u2', 'Priya', ['priya@acme.com']);
		sqlite.run(`UPDATE principals SET workspace_id = 'w2' WHERE user_id = 'u2'`);
		expect(await listAgents(db, 'u2')).toEqual([]);
	});

	test('send-as choices are your own addresses, or everyone\'s for an admin', async () => {
		const { sqlite, db } = open();
		addUser(sqlite, 'u2', 'Priya', ['priya@acme.com']);
		addUser(sqlite, 'u3', 'Root', ['root@acme.com'], true);
		expect(await sendAsChoices(db, 'u2')).toEqual(['priya@acme.com']);
		expect(await sendAsChoices(db, 'u3')).toEqual([
			'billing@acme.com',
			'priya@acme.com',
			'root@acme.com',
			'sada@acme.com'
		]);
	});

	test('pause all stops every agent, and their proposals are refused', async () => {
		const { db } = open();
		const agent = await activeAgent(db);
		await createAgent(db, { ownerUserId: 'u1', displayName: 'Scout', definition: billing });

		expect(await pauseAllAgents(db, 'u1')).toBe(2);
		expect(await pauseAllAgents(db, 'u1')).toBe(0);
		expect((await listAgents(db, 'u1')).every((item) => item.status === 'paused')).toBe(true);
		const { decision } = await proposeAction(db, { agentId: agent.id, proposal: reply, payload: {}, threadParticipants: ['client@globex.com'] });
		expect(decision).toEqual({ outcome: 'reject', reason: 'agent_paused' });
	});

	test('pause all only reaches your own workspace', async () => {
		const { sqlite, db } = open();
		const agent = await activeAgent(db);
		sqlite.run(`INSERT INTO workspaces (id, name) VALUES ('w2', 'Other')`);
		addUser(sqlite, 'u2', 'Priya', ['priya@acme.com']);
		sqlite.run(`UPDATE principals SET workspace_id = 'w2' WHERE user_id = 'u2'`);

		expect(await pauseAllAgents(db, 'u2')).toBe(0);
		expect((await getAgent(db, agent.id))?.status).toBe('active');
	});

	test('an agent is only visible to humans in its workspace', async () => {
		const { sqlite, db } = open();
		const agent = await activeAgent(db);
		expect((await getAgentForUser(db, agent.id, 'u1')).displayName).toBe('Billing');

		sqlite.run(`INSERT INTO workspaces (id, name) VALUES ('w2', 'Other')`);
		addUser(sqlite, 'u2', 'Priya', ['priya@acme.com']);
		sqlite.run(`UPDATE principals SET workspace_id = 'w2' WHERE user_id = 'u2'`);
		await expect(getAgentForUser(db, agent.id, 'u2')).rejects.toBeInstanceOf(AgentNotFoundError);
		await expect(getAgentForUser(db, agent.id, 'nobody')).rejects.toBeInstanceOf(NotAllowedError);
		await expect(pauseAllAgents(db, 'nobody')).rejects.toBeInstanceOf(NotAllowedError);
	});
});
