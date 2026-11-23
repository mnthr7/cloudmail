import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { D1Database } from '@cloudflare/workers-types';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createAgent, expireActions, proposeAction, setAgentStatus } from '../src/lib/server/agents-store';
import { defaultDefinition } from '../src/lib/agents/definition';
import { createExternalAgent, emitEvent, eventsSince } from '../src/lib/server/external-agents-store';
import { deliverWebhooks, setWebhook } from '../src/lib/server/agent-webhooks';
import { callTool } from '../src/lib/server/mcp/tools';
import { loadSession, runTool } from '../src/lib/server/mcp/server';
import type { EmailProvider } from '../src/lib/server/email-provider';
import type { OutboundMailInput } from '../src/lib/server/send-mail';

/** The owner hears when an agent is paused for them; an agent hears when its request expires. */

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

function fakeProvider() {
	const sent: OutboundMailInput[] = [];
	const provider = {
		kind: 'resend',
		async send(input: OutboundMailInput) {
			sent.push(input);
			return { providerId: `p${sent.length}` };
		},
		async listDomains() {
			return [];
		},
		async getDomain() {
			throw new Error('no');
		}
	} as unknown as EmailProvider;
	return { provider, sent };
}

async function open() {
	const sqlite = new Database(':memory:');
	sqlite.exec('PRAGMA foreign_keys = ON');
	for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
		sqlite.exec(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
	}
	sqlite.run(`INSERT INTO users (id, email, name, password_hash, is_admin) VALUES ('u1', 'u1@login.test', 'Sada', 'x', 0)`);
	sqlite.run(`INSERT INTO domains (id, name) VALUES ('d1', 'acme.com')`);
	sqlite.run(`INSERT INTO addresses (id, user_id, domain_id, address, is_default) VALUES ('a1', 'u1', 'd1', 'sada@acme.com', 1)`);
	sqlite.run(
		`INSERT INTO emails (id, user_id, direction, from_addr, to_addr, subject, body_text, thread_id, created_at)
		 VALUES ('m1', 'u1', 'inbound', 'pat@vc.com', 'sada@acme.com', 'Terms', 'Hello', 'm1', ?)`,
		[NOW.toISOString()]
	);
	const db = adapt(sqlite);
	const { agent, connection } = await createExternalAgent(
		db,
		{ ownerUserId: 'u1', displayName: 'Research', job: 'Help', readAddresses: ['sada@acme.com'], sendAs: ['sada@acme.com'], clientName: 'Claude', clientId: 'c1' },
		NOW
	);
	await setAgentStatus(db, { agentId: agent.id, byUserId: 'u1', status: 'active' });
	return { sqlite, db, agent, connection };
}

describe('when CloudMail pauses an agent, its owner gets one email', () => {
	test('after too many refused requests', async () => {
		const w = await open();
		const { provider, sent } = fakeProvider();
		const check = await loadSession(w.db, { connectionId: w.connection.id });
		if (!check.ok) throw new Error('no session');
		for (let i = 0; i < 11; i++) {
			await runTool({ db: w.db, provider, now: () => NOW }, check.session, 'send_reply', { thread_id: 'm1', body: 'x', to: ['someone@else.com'] });
		}
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ to: ['sada@acme.com'], subject: 'Research was paused', headers: { 'X-CloudMail-Notice': 'agent_paused' } });
		expect(sent[0].from.address).toBe('sada@acme.com');
		expect(sent[0].text).toContain('refused');
	});

	test('after its webhook fails for a day', async () => {
		const w = await open();
		const key = await crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), 'AES-GCM', false, ['encrypt', 'decrypt']);
		await setWebhook(w.db, key, { connectionId: w.connection.id, byUserId: 'u1', url: 'https://agent.example/hook' });
		await emitEvent(w.db, { agentId: w.agent.id, type: 'action.decided', actionId: 'x' }, NOW);
		const { provider, sent } = fakeProvider();
		const failing = async () => new Response('no', { status: 500 });
		await deliverWebhooks(w.db, key, failing, new Date(NOW.getTime() + 25 * 3_600_000), 20, provider);
		expect(sent.map((mail) => mail.subject)).toEqual(['Research was paused']);
		expect(sent[0].text).toContain('webhook');
	});
});

describe('requests waiting for approval expire, and the agent hears it', () => {
	test('a queued request says when it expires, and expiring it records action.decided', async () => {
		const w = await open();
		const { body } = await callTool(
			{ db: w.db, agent: (await (await import('../src/lib/server/agents-store')).getAgent(w.db, w.agent.id))!, connection: w.connection, mailbox: { id: 'u1', email: 'u1@login.test', name: 'Sada', is_admin: false, created_at: '' }, now: NOW },
			'send_reply',
			{ thread_id: 'm1', body: 'Thanks' }
		);
		expect(body).toMatchObject({ status: 'queued', expires_at: '2026-11-30T15:00:00.000Z' });
		expect(await expireActions(w.db, new Date('2026-11-29T00:00:00.000Z'))).toBe(0);
		expect(await expireActions(w.db, new Date('2026-12-01T00:00:00.000Z'))).toBe(1);
		const { events } = await eventsSince(w.db, w.agent.id, 0);
		expect(events).toMatchObject([{ type: 'action.decided', actionId: body.action_id, threadId: 'm1' }]);
	});

	test('built-in agents’ expiring proposals record no event', async () => {
		const w = await open();
		const sam = await createAgent(w.db, { ownerUserId: 'u1', displayName: 'Sam', definition: defaultDefinition('Help') }, NOW);
		await setAgentStatus(w.db, { agentId: sam.id, byUserId: 'u1', status: 'active' });
		await proposeAction(
			w.db,
			{ agentId: sam.id, proposal: { capability: 'organize' }, threadId: 'm1', payload: { emailId: 'm1', action: 'star' }, mailboxUserId: 'u1', expiresAt: new Date(NOW.getTime() + 1000) },
			NOW
		);
		expect(await expireActions(w.db, new Date(NOW.getTime() + 2000))).toBe(1);
		expect(w.sqlite.query(`SELECT COUNT(*) AS n FROM agent_events`).get()).toEqual({ n: 0 });
	});
});
