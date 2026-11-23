import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { D1Database } from '@cloudflare/workers-types';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { AgentDefinitionError } from '../src/lib/agents/definition';
import { proposeAction, setAgentStatus, updateAgentDefinition } from '../src/lib/server/agents-store';
import {
	auditToolCall,
	checkRateLimit,
	cleanClientName,
	connectionsForAgent,
	createExternalAgent,
	emitEvent,
	eventsSince,
	externalAgentsReading,
	getConnection,
	maybeAutoPause,
	redactArgs,
	revokeConnection,
	touchConnection
} from '../src/lib/server/external-agents-store';
import { latestEmailInThread, listMailbox, threadInAddresses } from '../src/lib/server/mail-store';

const MIGRATIONS = path.join(import.meta.dir, '../migrations');
const NOW = new Date('2026-11-23T12:00:00.000Z');

function migrate(sqlite: Database) {
	for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
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

let mailCount = 0;
function addMail(
	sqlite: Database,
	input: { from: string; to: string; cc?: string; thread?: string; user?: string; at?: string; subject?: string }
): string {
	const id = `m${++mailCount}`;
	sqlite.run(
		`INSERT INTO emails (id, user_id, direction, from_addr, to_addr, cc_addr, subject, body_text, thread_id, created_at)
		 VALUES (?, ?, 'inbound', ?, ?, ?, ?, 'Hello', ?, ?)`,
		[
			id,
			input.user ?? 'u1',
			input.from,
			input.to,
			input.cc ?? null,
			input.subject ?? 'Hi',
			input.thread ?? id,
			input.at ?? NOW.toISOString()
		]
	);
	return id;
}

function open() {
	const sqlite = new Database(':memory:');
	sqlite.exec('PRAGMA foreign_keys = ON');
	migrate(sqlite);
	addUser(sqlite, 'u1', 'Sada', ['sada@acme.com', 'sales@acme.com']);
	addUser(sqlite, 'u2', 'Kim', ['kim@acme.com']);
	return { sqlite, db: adapt(sqlite) };
}

async function hire(db: D1Database, overrides: Partial<Parameters<typeof createExternalAgent>[1]> = {}) {
	return createExternalAgent(
		db,
		{
			ownerUserId: 'u1',
			displayName: 'Research',
			job: 'Help with investor threads',
			readAddresses: ['sada@acme.com'],
			sendAs: ['sada@acme.com'],
			clientName: 'Claude',
			clientId: 'client-1',
			...overrides
		},
		NOW
	);
}

describe('hiring an external agent', () => {
	test('starts in shadow mode as an external agent with the external defaults and a live connection', async () => {
		const { db } = open();
		const { agent, connection } = await hire(db);
		expect(agent.runtime).toBe('external');
		expect(agent.status).toBe('shadow');
		const caps = agent.version.definition.capabilities;
		expect(caps.read_threads?.level).toBe('auto');
		expect(caps.draft_reply?.level).toBe('auto');
		expect(caps.organize?.level).toBe('approve');
		expect(caps.set_timer?.level).toBe('approve');
		expect(caps.send_reply?.level).toBe('approve');
		expect(caps.hand_off?.level).toBe('off');
		expect(caps.fetch_web?.level).toBe('off');
		expect(agent.version.definition.scope.read).toEqual({ addresses: ['sada@acme.com'] });
		expect(connection.status).toBe('active');
		expect(connection.mailboxUserId).toBe('u1');
		expect(connection.clientName).toBe('Claude');
	});

	test('can’t be given hand-off, web fetching or memory, at hiring or later', async () => {
		const { db } = open();
		await expect(hire(db, { levels: { hand_off: 'auto' } })).rejects.toBeInstanceOf(AgentDefinitionError);
		const { agent } = await hire(db);
		const definition = structuredClone(agent.version.definition);
		definition.capabilities.fetch_web = { level: 'auto' };
		await expect(
			updateAgentDefinition(db, { agentId: agent.id, byUserId: 'u1', definition })
		).rejects.toBeInstanceOf(AgentDefinitionError);
	});

	test('can only read addresses the person hiring it owns', async () => {
		const { db } = open();
		await expect(hire(db, { readAddresses: ['kim@acme.com'] })).rejects.toMatchObject({ code: 'scope' });
	});

	test('a client’s self-reported name is cleaned before it is shown', () => {
		expect(cleanClientName('  Claude\u0007 Desktop ')).toBe('Claude Desktop');
		expect(cleanClientName('')).toBe('Unnamed client');
		expect(cleanClientName('x'.repeat(200))).toHaveLength(80);
	});
});

describe('read scope', () => {
	test('matches whole addresses in from, to and cc, across the whole thread', async () => {
		const { sqlite, db } = open();
		const inScope = addMail(sqlite, { from: 'pat@vc.com', to: '"Sada" <sada@acme.com>' });
		addMail(sqlite, { from: 'pat@vc.com', to: 'kim@acme.com', thread: inScope });
		const ccOnly = addMail(sqlite, { from: 'lee@vc.com', to: 'kim@acme.com', cc: 'Sada <sada@acme.com>, x@y.com' });
		const lookalike = addMail(sqlite, { from: 'pat@vc.com', to: 'lisada@acme.com' });
		const other = addMail(sqlite, { from: 'pat@vc.com', to: 'sales@acme.com' });

		expect(await threadInAddresses(db, 'u1', inScope, ['sada@acme.com'])).toBe(true);
		expect(await threadInAddresses(db, 'u1', ccOnly, ['sada@acme.com'])).toBe(true);
		expect(await threadInAddresses(db, 'u1', lookalike, ['sada@acme.com'])).toBe(false);
		expect(await threadInAddresses(db, 'u1', other, ['sada@acme.com'])).toBe(false);
		expect(await threadInAddresses(db, 'u1', other, [])).toBe(false);

		const page = await listMailbox(db, 'u1', { view: 'all', addresses: ['sada@acme.com'] });
		expect(page.threads.map((thread) => thread.thread_id).sort()).toEqual([ccOnly, inScope].sort());
		expect((await listMailbox(db, 'u1', { view: 'all', addresses: [] })).total).toBe(0);
	});

	test('since leaves out older mail, and the latest message is what a thread action attaches to', async () => {
		const { sqlite, db } = open();
		const old = addMail(sqlite, { from: 'pat@vc.com', to: 'sada@acme.com', at: '2026-11-01T00:00:00.000Z' });
		const reply = addMail(sqlite, { from: 'pat@vc.com', to: 'sada@acme.com', thread: old, at: '2026-11-20T00:00:00.000Z' });
		const fresh = addMail(sqlite, { from: 'lee@vc.com', to: 'sada@acme.com', at: '2026-11-22T00:00:00.000Z' });
		const page = await listMailbox(db, 'u1', { view: 'all', since: '2026-11-21T00:00:00.000Z' });
		expect(page.threads.map((thread) => thread.thread_id)).toEqual([fresh]);
		expect((await latestEmailInThread(db, 'u1', old))?.id).toBe(reply);
		expect(await latestEmailInThread(db, 'u2', old)).toBeNull();
	});

	test('finds the external agents that read an address, skipping paused and revoked ones', async () => {
		const { db } = open();
		const reader = await hire(db);
		const sales = await hire(db, { readAddresses: ['sales@acme.com'], sendAs: [] });
		const paused = await hire(db);
		await setAgentStatus(db, { agentId: paused.agent.id, byUserId: 'u1', status: 'paused' });
		const revoked = await hire(db);
		await revokeConnection(db, { connectionId: revoked.connection.id, byUserId: 'u1' }, NOW);

		expect(await externalAgentsReading(db, 'u1', ['SADA@acme.com'])).toEqual([reader.agent.id]);
		expect(await externalAgentsReading(db, 'u1', ['sales@acme.com'])).toEqual([sales.agent.id]);
		expect(await externalAgentsReading(db, 'u2', ['sada@acme.com'])).toEqual([]);
	});
});

describe('connections', () => {
	test('revoking is a brake anyone in the workspace can pull', async () => {
		const { db } = open();
		const { connection } = await hire(db);
		const revoked = await revokeConnection(db, { connectionId: connection.id, byUserId: 'u2' }, NOW);
		expect(revoked.status).toBe('revoked');
		expect((await getConnection(db, connection.id))?.status).toBe('revoked');
	});

	test('last seen is written at most once a minute', async () => {
		const { db } = open();
		const { agent, connection } = await hire(db);
		await touchConnection(db, connection, NOW);
		const seen = (await connectionsForAgent(db, agent.id))[0];
		expect(seen.lastSeenAt).toBe(NOW.toISOString());
		await touchConnection(db, seen, new Date(NOW.getTime() + 30_000));
		expect((await getConnection(db, connection.id))?.lastSeenAt).toBe(NOW.toISOString());
		await touchConnection(db, seen, new Date(NOW.getTime() + 61_000));
		expect((await getConnection(db, connection.id))?.lastSeenAt).not.toBe(NOW.toISOString());
	});
});

describe('audit, rate limits and auto-pause', () => {
	test('audit keeps a hash and a redacted copy of the arguments', async () => {
		const { sqlite, db } = open();
		const { agent, connection } = await hire(db);
		await auditToolCall(
			db,
			{ agentId: agent.id, connectionId: connection.id, tool: 'send_reply', args: { body: 'x'.repeat(500) }, decision: 'queued', latencyMs: 12 },
			NOW
		);
		const row = sqlite.query(`SELECT * FROM tool_call_audit`).get() as Record<string, string>;
		expect(row.args_hash).toBeTruthy();
		expect(JSON.parse(row.args_redacted_json).body).toContain('(500 chars)');
		expect(redactArgs({ a: ['short'] })).toEqual({ a: ['short'] });
	});

	test('more than the per-minute limit is refused until the minute passes', async () => {
		const { db } = open();
		const { agent } = await hire(db);
		for (let i = 0; i < 3; i++) {
			await auditToolCall(db, { agentId: agent.id, connectionId: null, tool: 'whoami', args: {}, decision: 'read', latencyMs: 1 }, NOW);
		}
		const limits = { perMinute: 3, perDay: 100 };
		expect(await checkRateLimit(db, agent.id, NOW, limits)).toEqual({ ok: false, window: 'minute', retryAfterSeconds: 60 });
		expect(await checkRateLimit(db, agent.id, new Date(NOW.getTime() + 61_000), limits)).toEqual({ ok: true });
		expect(await checkRateLimit(db, agent.id, NOW, { perMinute: 10, perDay: 3 })).toMatchObject({ ok: false, window: 'day' });
	});

	test('an agent refused more than 10 times in an hour is paused, with the reason kept until resumed', async () => {
		const { sqlite, db } = open();
		const { agent } = await hire(db);
		for (let i = 0; i < 11; i++) {
			await proposeAction(
				db,
				{ agentId: agent.id, proposal: { capability: 'hand_off' }, threadId: 't1', payload: {}, mailboxUserId: 'u1' },
				NOW
			);
		}
		expect(await maybeAutoPause(db, agent.id, NOW)).toBe('too_many_rejections');
		expect(await maybeAutoPause(db, agent.id, NOW)).toBeNull();
		const row = sqlite.query(`SELECT status, paused_reason FROM agents WHERE principal_id = ?`).get(agent.id);
		expect(row).toEqual({ status: 'paused', paused_reason: 'too_many_rejections' });
		await setAgentStatus(db, { agentId: agent.id, byUserId: 'u1', status: 'shadow' });
		expect(sqlite.query(`SELECT paused_reason FROM agents WHERE principal_id = ?`).get(agent.id)).toEqual({ paused_reason: null });
	});
});

describe('events', () => {
	test('pages through events by cursor, and queues a delivery only for connections with a webhook', async () => {
		const { sqlite, db } = open();
		const { agent, connection } = await hire(db);
		const first = await emitEvent(db, { agentId: agent.id, type: 'message.received', threadId: 't1', emailId: 'm1' }, NOW);
		expect(sqlite.query(`SELECT COUNT(*) AS n FROM webhook_deliveries`).get()).toEqual({ n: 0 });

		sqlite.run(`UPDATE agent_connections SET webhook_url = 'https://agent.example/hook' WHERE id = ?`, [connection.id]);
		const second = await emitEvent(db, { agentId: agent.id, type: 'action.decided', actionId: 'act1' }, NOW);
		expect(sqlite.query(`SELECT connection_id, event_seq, status FROM webhook_deliveries`).all()).toEqual([
			{ connection_id: connection.id, event_seq: second, status: 'pending' }
		]);

		const page = await eventsSince(db, agent.id, 0, 1);
		expect(page.events.map((event) => event.seq)).toEqual([first]);
		expect(page.more).toBe(true);
		const next = await eventsSince(db, agent.id, page.cursor);
		expect(next.events).toMatchObject([{ seq: second, type: 'action.decided', actionId: 'act1' }]);
		expect(next.more).toBe(false);
		expect((await eventsSince(db, agent.id, next.cursor)).cursor).toBe(next.cursor);
	});
});
