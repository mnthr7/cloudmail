import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { D1Database } from '@cloudflare/workers-types';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { proposeAction, decideAction, setAgentStatus } from '../src/lib/server/agents-store';
import {
	checkWebhookUrl,
	deliverWebhooks,
	emitActionDecided,
	recentDeliveries,
	retryDelayMs,
	setWebhook,
	WebhookUrlError
} from '../src/lib/server/agent-webhooks';
import { enqueueAskRun } from '../src/lib/server/agent-runs-store';
import { createExternalAgent, emitEvent, eventsSince, revokeConnection } from '../src/lib/server/external-agents-store';
import { verifyWebhookSignature } from '../src/lib/server/webhook';
import { organizeInbound } from '../src/lib/server/organize-inbound';

/** Webhooks to external agents (docs/specs/external-agents.md, X4). */

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

async function masterKey(): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function open() {
	const sqlite = new Database(':memory:');
	sqlite.exec('PRAGMA foreign_keys = ON');
	for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
		sqlite.exec(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
	}
	sqlite.run(`INSERT INTO users (id, email, name, password_hash, is_admin) VALUES ('u1', 'u1@login.test', 'Sada', 'x', 0)`);
	sqlite.run(`INSERT INTO users (id, email, name, password_hash, is_admin) VALUES ('u2', 'u2@login.test', 'Kim', 'x', 0)`);
	sqlite.run(`INSERT INTO domains (id, name) VALUES ('d1', 'acme.com')`);
	sqlite.run(`INSERT INTO addresses (id, user_id, domain_id, address, is_default) VALUES ('a1', 'u1', 'd1', 'sada@acme.com', 1)`);
	const db = adapt(sqlite);
	const { agent, connection } = await createExternalAgent(
		db,
		{
			ownerUserId: 'u1',
			displayName: 'Research',
			job: 'Help with investor threads.',
			readAddresses: ['sada@acme.com'],
			sendAs: ['sada@acme.com'],
			clientName: 'My bot',
			clientId: 'c1'
		},
		NOW
	);
	const key = await masterKey();
	return { sqlite, db, agent, connection, key };
}

function recorder(status = 200) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fetcher = async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		return new Response('ok', { status });
	};
	return { calls, fetcher };
}

describe('webhook URLs', () => {
	test('only public https', () => {
		expect(checkWebhookUrl('https://agent.example/hook#x')).toBe('https://agent.example/hook');
		for (const bad of ['http://agent.example/hook', 'https://localhost/hook', 'https://10.0.0.5/hook', 'https://192.168.1.2/', 'https://[::1]/', 'https://user:pw@agent.example/', 'nope']) {
			expect(() => checkWebhookUrl(bad)).toThrow(WebhookUrlError);
		}
	});

	test('only the agent’s owner sets it, and a new URL gets a new secret', async () => {
		const w = await open();
		await expect(setWebhook(w.db, w.key, { connectionId: w.connection.id, byUserId: 'u2', url: 'https://agent.example/hook' })).rejects.toThrow();
		const first = await setWebhook(w.db, w.key, { connectionId: w.connection.id, byUserId: 'u1', url: 'https://agent.example/hook' });
		const second = await setWebhook(w.db, w.key, { connectionId: w.connection.id, byUserId: 'u1', url: 'https://agent.example/hook' });
		expect(first.secret).toStartWith('whsec_');
		expect(second.secret).not.toBe(first.secret);
		const stored = w.sqlite.query(`SELECT webhook_secret_enc FROM agent_connections`).get() as { webhook_secret_enc: string };
		expect(stored.webhook_secret_enc).not.toContain(second.secret!.slice(6));
	});
});

describe('delivering events', () => {
	test('a signed POST with IDs only, that the agent can verify with its secret', async () => {
		const w = await open();
		const { secret } = await setWebhook(w.db, w.key, { connectionId: w.connection.id, byUserId: 'u1', url: 'https://agent.example/hook' });
		await emitEvent(w.db, { agentId: w.agent.id, type: 'message.received', threadId: 't1', emailId: 'm1' }, NOW);
		const { calls, fetcher } = recorder();
		expect(await deliverWebhooks(w.db, w.key, fetcher, new Date())).toEqual({ delivered: 1, failed: 0, dead: 0 });
		expect(calls).toHaveLength(1);
		const body = calls[0].init.body as string;
		expect(JSON.parse(body)).toMatchObject({ type: 'message.received', data: { thread_id: 't1', email_id: 'm1' }, cursor: '1' });
		expect(body).not.toContain('Hello');
		const headers = new Headers(calls[0].init.headers);
		expect(await verifyWebhookSignature(headers, body, secret!)).toEqual({ ok: true });
		// Delivered once.
		expect((await deliverWebhooks(w.db, w.key, fetcher, new Date())).delivered).toBe(0);
		expect((await recentDeliveries(w.db, w.connection.id))[0]).toMatchObject({ status: 'delivered', statusCode: 200, attempt: 1 });
	});

	test('failures retry with backoff, and after a day of only failures the agent is paused', async () => {
		const w = await open();
		await setWebhook(w.db, w.key, { connectionId: w.connection.id, byUserId: 'u1', url: 'https://agent.example/hook' });
		await emitEvent(w.db, { agentId: w.agent.id, type: 'action.decided', actionId: 'x1' }, NOW);
		const { fetcher } = recorder(500);
		expect(await deliverWebhooks(w.db, w.key, fetcher, NOW)).toEqual({ delivered: 0, failed: 1, dead: 0 });
		// Not due again until the backoff passes.
		expect(await deliverWebhooks(w.db, w.key, fetcher, new Date(NOW.getTime() + 10_000))).toEqual({ delivered: 0, failed: 0, dead: 0 });
		expect(await deliverWebhooks(w.db, w.key, fetcher, new Date(NOW.getTime() + retryDelayMs(1) + 1))).toMatchObject({ failed: 1 });
		expect(retryDelayMs(2)).toBe(60_000);
		expect(retryDelayMs(20)).toBe(3_600_000);

		const dayLater = new Date(NOW.getTime() + 25 * 3_600_000);
		expect(await deliverWebhooks(w.db, w.key, fetcher, dayLater)).toEqual({ delivered: 0, failed: 0, dead: 1 });
		expect(w.sqlite.query(`SELECT status, paused_reason FROM agents`).get()).toEqual({ status: 'paused', paused_reason: 'webhooks_failing' });
	});

	test('nothing goes to a revoked connection', async () => {
		const w = await open();
		await setWebhook(w.db, w.key, { connectionId: w.connection.id, byUserId: 'u1', url: 'https://agent.example/hook' });
		await emitEvent(w.db, { agentId: w.agent.id, type: 'message.received', threadId: 't1', emailId: 'm1' }, NOW);
		await revokeConnection(w.db, { connectionId: w.connection.id, byUserId: 'u1' }, NOW);
		const { calls, fetcher } = recorder();
		expect(await deliverWebhooks(w.db, w.key, fetcher, NOW)).toEqual({ delivered: 0, failed: 0, dead: 1 });
		expect(calls).toHaveLength(0);
	});
});

describe('what external agents hear about', () => {
	test('a decision on its proposal', async () => {
		const w = await open();
		await setAgentStatus(w.db, { agentId: w.agent.id, byUserId: 'u1', status: 'active' });
		w.sqlite.run(
			`INSERT INTO emails (id, user_id, direction, from_addr, to_addr, subject, body_text, thread_id, created_at)
			 VALUES ('m1', 'u1', 'inbound', 'pat@vc.com', 'sada@acme.com', 'Hi', 'Hello', 'm1', ?)`,
			[NOW.toISOString()]
		);
		const { actionId } = await proposeAction(
			w.db,
			{ agentId: w.agent.id, proposal: { capability: 'organize' }, threadId: 'm1', payload: { emailId: 'm1', action: 'star' }, mailboxUserId: 'u1' },
			NOW
		);
		await decideAction(w.db, { actionId, byUserId: 'u1', decision: 'decline' }, NOW);
		await emitActionDecided(w.db, actionId, NOW);
		expect((await eventsSince(w.db, w.agent.id, 0)).events).toMatchObject([{ type: 'action.decided', actionId, threadId: 'm1' }]);
	});

	test('being asked on a thread: an event, never a run of the built-in model', async () => {
		const w = await open();
		w.sqlite.run(
			`INSERT INTO emails (id, user_id, direction, from_addr, to_addr, subject, body_text, thread_id, created_at)
			 VALUES ('m1', 'u1', 'inbound', 'pat@vc.com', 'sada@acme.com', 'Hi', 'Hello', 'm1', ?)`,
			[NOW.toISOString()]
		);
		const ref = await enqueueAskRun(w.db, { agentId: w.agent.id, byUserId: 'u1', emailId: 'm1', request: 'Can you draft a reply?' }, NOW);
		expect(ref).toStartWith('ev_');
		expect(w.sqlite.query(`SELECT COUNT(*) AS n FROM agent_runs`).get()).toEqual({ n: 0 });
		expect((await eventsSince(w.db, w.agent.id, 0)).events).toMatchObject([{ type: 'mention.created', threadId: 'm1', emailId: 'm1' }]);
	});

	test('new mail to an address it reads, but not automated mail or mail to other addresses', async () => {
		const w = await open();
		w.sqlite.run(`INSERT INTO addresses (id, user_id, domain_id, address) VALUES ('a2', 'u1', 'd1', 'hr@acme.com')`);
		const add = (id: string, to: string) =>
			w.sqlite.run(
				`INSERT INTO emails (id, user_id, direction, from_addr, to_addr, subject, body_text, thread_id, created_at)
				 VALUES (?, 'u1', 'inbound', 'pat@vc.com', ?, 'Hi', 'Hello', ?, ?)`,
				[id, to, id, NOW.toISOString()]
			);
		add('m1', 'Sada <sada@acme.com>');
		add('m2', 'hr@acme.com');
		add('m3', 'sada@acme.com');
		await organizeInbound(w.db, 'u1', 'm1', { hasAttachment: false });
		await organizeInbound(w.db, 'u1', 'm2', { hasAttachment: false });
		await organizeInbound(w.db, 'u1', 'm3', { hasAttachment: false, autoSubmitted: 'auto-replied' });
		expect((await eventsSince(w.db, w.agent.id, 0)).events).toMatchObject([{ type: 'message.received', threadId: 'm1', emailId: 'm1' }]);
	});
});
