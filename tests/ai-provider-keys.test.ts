import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { D1Database } from '@cloudflare/workers-types';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { NotAllowedError } from '../src/lib/server/agents-store';
import {
	listProviderStatus,
	loadProviderKey,
	markProviderKeyRejected,
	ProviderKeyError,
	removeProviderKey,
	setProviderKey,
	workspacesWithWorkingKey
} from '../src/lib/server/ai-provider-store';
import { importMasterKey, openSecret, sealSecret, SecretBoxError } from '../src/lib/server/secret-box';

const MIGRATIONS = path.join(import.meta.dir, '../migrations');
const API_KEY = 'sk-ant-api03-test-key-0000000000000000wxyz';
const NOW = new Date('2026-11-07T15:00:00Z');

function masterSecret(fill = 7): string {
	return btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)));
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

function open() {
	const sqlite = new Database(':memory:');
	sqlite.exec('PRAGMA foreign_keys = ON');
	for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
		sqlite.exec(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
	}
	for (const [id, name, admin] of [
		['admin', 'Sada', 1],
		['member', 'Kim', 0]
	] as const) {
		sqlite.run(`INSERT INTO users (id, email, name, password_hash, is_admin) VALUES (?, ?, ?, 'x', ?)`, [
			id,
			`${id}@login.test`,
			name,
			admin
		]);
	}
	return { sqlite, db: adapt(sqlite) };
}

const accept = async () => 'ok' as const;

describe('secret box', () => {
	test('a sealed secret opens only with the same master key and context', async () => {
		const key = await importMasterKey(masterSecret());
		const sealed = await sealSecret(key, API_KEY, 'workspace-ai-key:default:anthropic');
		expect(sealed.startsWith('v1.')).toBe(true);
		expect(sealed).not.toContain(API_KEY);
		expect(await openSecret(key, sealed, 'workspace-ai-key:default:anthropic')).toBe(API_KEY);

		// Each seal uses a fresh IV.
		expect(await sealSecret(key, API_KEY, 'ctx')).not.toBe(await sealSecret(key, API_KEY, 'ctx'));

		await expect(openSecret(key, sealed, 'workspace-ai-key:other:anthropic')).rejects.toBeInstanceOf(SecretBoxError);
		const otherKey = await importMasterKey(masterSecret(9));
		await expect(openSecret(otherKey, sealed, 'workspace-ai-key:default:anthropic')).rejects.toBeInstanceOf(
			SecretBoxError
		);
		await expect(openSecret(key, 'v1.nope', 'ctx')).rejects.toBeInstanceOf(SecretBoxError);
	});

	test('the master key must be 32 bytes of base64', async () => {
		await expect(importMasterKey(undefined)).rejects.toBeInstanceOf(SecretBoxError);
		await expect(importMasterKey('not base64 at all!')).rejects.toBeInstanceOf(SecretBoxError);
		await expect(importMasterKey(btoa('too short'))).rejects.toBeInstanceOf(SecretBoxError);
	});
});

describe('workspace AI provider keys', () => {
	test('an admin saves a key: checked, stored encrypted, recorded, and never shown again', async () => {
		const { sqlite, db } = open();
		const masterKey = await importMasterKey(masterSecret());
		const checked: string[] = [];

		const status = await setProviderKey(
			db,
			{
				userId: 'admin',
				provider: 'anthropic',
				apiKey: `  ${API_KEY}  `,
				masterKey,
				check: async (_provider, key) => {
					checked.push(key);
					return 'ok';
				}
			},
			NOW
		);

		expect(checked).toEqual([API_KEY]);
		expect(status).toEqual({
			provider: 'anthropic',
			hint: 'wxyz',
			setBy: 'Sada',
			updatedAt: NOW.toISOString(),
			rejectedAt: null
		});
		// The status the pages see holds no key material.
		expect(JSON.stringify(await listProviderStatus(db, 'default'))).not.toContain('sk-ant');

		const row = sqlite.query(`SELECT key_sealed FROM workspace_ai_providers`).get() as { key_sealed: string };
		expect(row.key_sealed).not.toContain(API_KEY);
		expect(await loadProviderKey(db, masterKey, 'default', 'anthropic')).toBe(API_KEY);

		const events = sqlite.query(`SELECT action, key_hint, by_principal_id FROM workspace_ai_provider_events`).all();
		expect(events).toEqual([{ action: 'set', key_hint: 'wxyz', by_principal_id: 'p_admin' }]);
		expect(JSON.stringify(sqlite.query(`SELECT * FROM workspace_ai_provider_events`).all())).not.toContain('sk-ant');

		expect(await workspacesWithWorkingKey(db, 'anthropic')).toEqual(['default']);
	});

	test('only admins can set or remove a key', async () => {
		const { db } = open();
		const masterKey = await importMasterKey(masterSecret());
		await expect(
			setProviderKey(db, { userId: 'member', provider: 'anthropic', apiKey: API_KEY, masterKey, check: accept })
		).rejects.toBeInstanceOf(NotAllowedError);
		await setProviderKey(db, { userId: 'admin', provider: 'anthropic', apiKey: API_KEY, masterKey, check: accept });
		await expect(removeProviderKey(db, { userId: 'member', provider: 'anthropic' })).rejects.toBeInstanceOf(
			NotAllowedError
		);
		expect(await workspacesWithWorkingKey(db, 'anthropic')).toEqual(['default']);
	});

	test('bad input, a refused key, or a missing master key stores nothing', async () => {
		const { sqlite, db } = open();
		const masterKey = await importMasterKey(masterSecret());
		const attempt = (input: Partial<Parameters<typeof setProviderKey>[1]>) =>
			setProviderKey(db, {
				userId: 'admin',
				provider: 'anthropic',
				apiKey: API_KEY,
				masterKey,
				check: accept,
				...input
			}).then(
				() => 'saved',
				(error: unknown) => (error instanceof ProviderKeyError ? error.code : String(error))
			);

		expect(await attempt({ provider: 'openai' })).toBe('provider');
		expect(await attempt({ apiKey: 'short' })).toBe('key');
		expect(await attempt({ apiKey: 'sk-ant has spaces in the middle of it' })).toBe('key');
		expect(await attempt({ apiKey: 42 })).toBe('key');
		expect(await attempt({ masterKey: null })).toBe('encryption');
		expect(await attempt({ check: async () => 'rejected' })).toBe('rejected');
		expect(await attempt({ check: async () => 'unreachable' })).toBe('unreachable');

		expect(sqlite.query(`SELECT COUNT(*) AS n FROM workspace_ai_providers`).get()).toEqual({ n: 0 });
		expect(sqlite.query(`SELECT COUNT(*) AS n FROM workspace_ai_provider_events`).get()).toEqual({ n: 0 });
	});

	test('a key the provider turns down pauses the workspace until a new one is saved', async () => {
		const { sqlite, db } = open();
		const masterKey = await importMasterKey(masterSecret());
		await setProviderKey(db, { userId: 'admin', provider: 'anthropic', apiKey: API_KEY, masterKey, check: accept });

		await markProviderKeyRejected(db, 'default', 'anthropic', NOW);
		await markProviderKeyRejected(db, 'default', 'anthropic', NOW);
		expect(await workspacesWithWorkingKey(db, 'anthropic')).toEqual([]);
		expect((await listProviderStatus(db, 'default'))[0].rejectedAt).toBe(NOW.toISOString());
		// Recorded once, not once per failed run.
		expect(sqlite.query(`SELECT COUNT(*) AS n FROM workspace_ai_provider_events WHERE action = 'rejected'`).get()).toEqual({
			n: 1
		});

		await setProviderKey(db, {
			userId: 'admin',
			provider: 'anthropic',
			apiKey: `${API_KEY}-new1`,
			masterKey,
			check: accept
		});
		expect(await workspacesWithWorkingKey(db, 'anthropic')).toEqual(['default']);
		expect(await listProviderStatus(db, 'default')).toMatchObject([{ hint: 'new1', rejectedAt: null }]);
	});

	test('a sealed key copied to another workspace does not open there', async () => {
		const { sqlite, db } = open();
		const masterKey = await importMasterKey(masterSecret());
		await setProviderKey(db, { userId: 'admin', provider: 'anthropic', apiKey: API_KEY, masterKey, check: accept });
		sqlite.run(`INSERT INTO workspaces (id, name) VALUES ('other', 'Other')`);
		sqlite.run(
			`INSERT INTO workspace_ai_providers (workspace_id, provider, key_sealed, key_hint, updated_at)
			 SELECT 'other', provider, key_sealed, key_hint, updated_at FROM workspace_ai_providers WHERE workspace_id = 'default'`
		);
		await expect(loadProviderKey(db, masterKey, 'other', 'anthropic')).rejects.toBeInstanceOf(SecretBoxError);
		expect(await loadProviderKey(db, masterKey, 'nobody', 'anthropic')).toBeNull();
	});

	test('removing a key stops agents and is recorded', async () => {
		const { sqlite, db } = open();
		const masterKey = await importMasterKey(masterSecret());
		await setProviderKey(db, { userId: 'admin', provider: 'anthropic', apiKey: API_KEY, masterKey, check: accept });

		expect(await removeProviderKey(db, { userId: 'admin', provider: 'anthropic' }, NOW)).toBe(true);
		expect(await removeProviderKey(db, { userId: 'admin', provider: 'anthropic' }, NOW)).toBe(false);
		expect(await workspacesWithWorkingKey(db, 'anthropic')).toEqual([]);
		expect(await loadProviderKey(db, masterKey, 'default', 'anthropic')).toBeNull();
		expect(sqlite.query(`SELECT action FROM workspace_ai_provider_events ORDER BY action DESC`).all()).toEqual([
			{ action: 'set' },
			{ action: 'removed' }
		]);
	});
});
