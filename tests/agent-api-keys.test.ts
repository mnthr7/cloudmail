import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { D1Database } from '@cloudflare/workers-types';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
	connectionForApiKey,
	connectionsForAgent,
	createApiKey,
	createExternalAgent,
	hireExternalAgent,
	isApiKey,
	revokeConnection
} from '../src/lib/server/external-agents-store';
import { handleMcpRequest } from '../src/lib/server/mcp/server';
import { POST as hireWithKey } from '../src/routes/api/agents/external/+server';

/** API keys for agents that can't sign in through a browser (external-agents.md, X9). */

const MIGRATIONS = path.join(import.meta.dir, '../migrations');
const NOW = new Date('2026-11-23T15:00:00.000Z');

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

function open() {
	const sqlite = new Database(':memory:');
	sqlite.exec('PRAGMA foreign_keys = ON');
	for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
		sqlite.exec(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
	}
	sqlite.run(`INSERT INTO users (id, email, name, password_hash, is_admin) VALUES ('u1', 'u1@login.test', 'Sada', 'x', 0)`);
	sqlite.run(`INSERT INTO users (id, email, name, password_hash, is_admin) VALUES ('u2', 'u2@login.test', 'Kim', 'x', 0)`);
	sqlite.run(`INSERT INTO domains (id, name) VALUES ('d1', 'acme.com')`);
	sqlite.run(`INSERT INTO addresses (id, user_id, domain_id, address, is_default) VALUES ('a1', 'u1', 'd1', 'sada@acme.com', 1)`);
	return { sqlite, db: adapt(sqlite) };
}

const hire = (db: D1Database) =>
	hireExternalAgent(db, { ownerUserId: 'u1', displayName: 'Grok', job: 'Triage', readAddresses: ['sada@acme.com'], sendAs: [] }, NOW);

async function mcp(db: D1Database, key: string, method: string, params: unknown = {}) {
	const connection = await connectionForApiKey(db, key);
	if (!connection) return null;
	const response = await handleMcpRequest(
		new Request('https://mail.acme.com/mcp', {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
		}),
		{ connectionId: connection.id },
		{ db, now: () => NOW }
	);
	return (await response.json()) as Record<string, any>;
}

describe('API keys', () => {
	test('a key is only kept as a fingerprint, and finds its agent', async () => {
		const { sqlite, db } = open();
		const agent = await hire(db);
		const { key, connection } = await createApiKey(db, { agentId: agent.id, byUserId: 'u1' }, NOW);
		expect(isApiKey(key)).toBe(true);
		expect(connection).toMatchObject({ auth: 'api_key', mailboxUserId: 'u1', status: 'active' });
		expect(connection.keyHint).toBe(key.slice(0, 10));
		const stored = JSON.stringify(sqlite.query(`SELECT * FROM agent_connections`).all());
		expect(stored).not.toContain(key);
		expect((await connectionForApiKey(db, key))?.agentId).toBe(agent.id);
		expect(await connectionForApiKey(db, `${key}x`)).toBeNull();
		expect(await connectionForApiKey(db, 'not-a-key')).toBeNull();
	});

	test('it speaks MCP as the agent, in shadow mode like any other', async () => {
		const { db } = open();
		const agent = await hire(db);
		const { key } = await createApiKey(db, { agentId: agent.id, byUserId: 'u1' }, NOW);
		const who = await mcp(db, key, 'tools/call', { name: 'whoami', arguments: {} });
		expect(who?.result.structuredContent).toMatchObject({ name: 'Grok', status: 'shadow', read_addresses: ['sada@acme.com'] });
	});

	test('a new key replaces the old one; revoking stops it; OAuth connections are left alone', async () => {
		const { db } = open();
		const { agent, connection: oauth } = await createExternalAgent(
			db,
			{ ownerUserId: 'u1', displayName: 'Claude', job: 'Help', readAddresses: ['sada@acme.com'], sendAs: [], clientName: 'Claude', clientId: 'c1' },
			NOW
		);
		const first = await createApiKey(db, { agentId: agent.id, byUserId: 'u1' }, NOW);
		const second = await createApiKey(db, { agentId: agent.id, byUserId: 'u1' }, NOW);
		expect(await connectionForApiKey(db, first.key)).toBeNull();
		expect(await connectionForApiKey(db, second.key)).not.toBeNull();
		const statuses = Object.fromEntries((await connectionsForAgent(db, agent.id)).map((item) => [item.id, item.status]));
		expect(statuses[oauth.id]).toBe('active');
		await revokeConnection(db, { connectionId: second.connection.id, byUserId: 'u1' }, NOW);
		expect(await connectionForApiKey(db, second.key)).toBeNull();
	});

	test('only the agent’s owner or an admin makes keys, and only for external agents', async () => {
		const { db } = open();
		const agent = await hire(db);
		await expect(createApiKey(db, { agentId: agent.id, byUserId: 'u2' }, NOW)).rejects.toThrow();
		await expect(createApiKey(db, { agentId: 'p_u1', byUserId: 'u1' }, NOW)).rejects.toThrow();
	});
});

describe('hiring an agent with a key from the Staff page', () => {
	function event(db: D1Database, body: unknown, userId = 'u1') {
		return {
			request: new Request('https://mail.acme.com/api/agents/external', { method: 'POST', body: JSON.stringify(body) }),
			locals: { user: { id: userId } },
			platform: { env: { DB: db } }
		} as never;
	}

	test('creates the agent in shadow mode and returns its key once', async () => {
		const { db } = open();
		const response = await hireWithKey(event(db, { name: 'Grok', readAddresses: ['sada@acme.com'], sendAs: ['sada@acme.com'] }));
		expect(response.status).toBe(201);
		const body = (await response.json()) as { agentId: string; key: string };
		expect(isApiKey(body.key)).toBe(true);
		expect((await connectionForApiKey(db, body.key))?.agentId).toBe(body.agentId);
	});

	test('refuses addresses that aren’t yours, or no read scope', async () => {
		const { db } = open();
		expect((await hireWithKey(event(db, { name: 'Grok', readAddresses: [] }))).status).toBe(400);
		expect((await hireWithKey(event(db, { name: 'Grok', readAddresses: ['sada@acme.com'] }, 'u2'))).status).toBe(400);
	});
});
