import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import type { D1Database } from '@cloudflare/workers-types';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { bootstrapAdmin } from '../src/lib/server/auth';

function open(): { sqlite: Database; db: D1Database } {
	const sqlite = new Database(':memory:');
	const schema = readFileSync(path.join(import.meta.dir, '../migrations/0001_init.sql'), 'utf8');
	sqlite.exec(schema.slice(0, schema.indexOf('CREATE TABLE sessions')));
	const statement = (sql: string, values: unknown[] = []) => ({
		bind: (...params: unknown[]) => statement(sql, params),
		async first() {
			return sqlite.query(sql).get(...(values as never[])) ?? null;
		},
		async all() {
			return { results: sqlite.query(sql).all(...(values as never[])), success: true, meta: {} };
		},
		async run() {
			const info = sqlite.run(sql, values as never[]);
			return { success: true, meta: { changes: info.changes } };
		}
	});
	return { sqlite, db: { prepare: (sql: string) => statement(sql) } as unknown as D1Database };
}

test('two setups racing create exactly one admin', async () => {
	const { sqlite, db } = open();
	const results = await Promise.allSettled([
		bootstrapAdmin(db, { email: 'a@example.com', name: 'A', password: 'password-a' }),
		bootstrapAdmin(db, { email: 'b@example.com', name: 'B', password: 'password-b' })
	]);
	expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
	expect(sqlite.query('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 1 });
});
