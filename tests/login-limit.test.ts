import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { D1Database } from '@cloudflare/workers-types';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
	LOGIN_WINDOW_MS,
	loginKeys,
	releaseLoginAttempt,
	reserveLoginAttempt
} from '../src/lib/server/login-limit';

function open() {
	const sqlite = new Database(':memory:');
	sqlite.exec(readFileSync(path.join(import.meta.dir, '../migrations/0014_login_limit.sql'), 'utf8'));
	return adapt(sqlite);
}

function adapt(sqlite: Database): D1Database {
	return {
		prepare(sql: string) {
			return {
				bind(...params: unknown[]) {
					const values = params.map((value) => (value === undefined ? null : value));
					return {
						async all() {
							const results = sqlite.query(sql).all(...(values as never[]));
							return { results, success: true, meta: {} };
						},
						async run() {
							const info = sqlite.run(sql, values as never[]);
							return { success: true, meta: { changes: info.changes } };
						},
						async first() {
							return sqlite.query(sql).get(...(values as never[])) ?? null;
						}
					};
				}
			};
		}
	} as unknown as D1Database;
}

describe('login rate limit', () => {
	const start = new Date('2026-11-03T12:00:00Z');

	test('ten attempts per account go through, the eleventh waits out the window', async () => {
		const db = open();
		const keys = loginKeys('203.0.113.7', 'Ada@Example.com');
		for (let i = 0; i < 10; i++) expect(await reserveLoginAttempt(db, keys, start)).toBeNull();
		expect(await reserveLoginAttempt(db, keys, start)).toBe(LOGIN_WINDOW_MS / 1000);
	});

	test('parallel guesses cannot all slip under the limit', async () => {
		const db = open();
		const keys = loginKeys('203.0.113.7', 'ada@example.com');
		const results = await Promise.all(
			Array.from({ length: 30 }, () => reserveLoginAttempt(db, keys, start))
		);
		expect(results.filter((wait) => wait === null)).toHaveLength(10);
	});

	test('the same account from another IP is still blocked', async () => {
		const db = open();
		for (let i = 0; i < 10; i++) await reserveLoginAttempt(db, loginKeys('203.0.113.7', 'ada@example.com'), start);
		expect(await reserveLoginAttempt(db, loginKeys('198.51.100.9', 'ADA@example.com'), start)).not.toBeNull();
	});

	test('a new window starts once the old one has passed', async () => {
		const db = open();
		const keys = loginKeys(null, 'ada@example.com');
		for (let i = 0; i < 11; i++) await reserveLoginAttempt(db, keys, start);
		const later = new Date(start.getTime() + LOGIN_WINDOW_MS + 1000);
		expect(await reserveLoginAttempt(db, keys, later)).toBeNull();
	});

	test('a correct password clears the account and refunds the IP', async () => {
		const db = open();
		const keys = loginKeys('203.0.113.7', 'ada@example.com');
		for (let i = 0; i < 25; i++) {
			expect(await reserveLoginAttempt(db, keys, start)).toBeNull();
			await releaseLoginAttempt(db, keys);
		}
	});
});
