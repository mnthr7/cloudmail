import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { D1Database } from '@cloudflare/workers-types';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
	clientNetwork,
	knownDevice,
	rememberDevice,
	LOGIN_WINDOW_MS,
	loginKeys,
	releaseLoginAttempt,
	reserveLoginAttempt
} from '../src/lib/server/login-limit';

let lastSqlite: Database;

function open() {
	const sqlite = new Database(':memory:');
	sqlite.exec(readFileSync(path.join(import.meta.dir, '../migrations/0014_login_limit.sql'), 'utf8'));
	sqlite.exec(
		`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL)`
	);
	sqlite.run(`INSERT INTO users (id, email, password_hash) VALUES ('u1', 'ada@example.com', 'salt:hash-1')`);
	lastSqlite = sqlite;
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

	test('a lockout from one IP does not block the owner on another', async () => {
		const db = open();
		for (let i = 0; i < 15; i++) await reserveLoginAttempt(db, loginKeys('203.0.113.7', 'ada@example.com'), start);
		expect(await reserveLoginAttempt(db, loginKeys('198.51.100.9', 'ADA@example.com'), start)).toBeNull();
	});

	test('guesses spread over many IPs still hit the account ceiling', async () => {
		const db = open();
		for (let i = 0; i < 20; i++) {
			expect(await reserveLoginAttempt(db, loginKeys(`10.0.${Math.floor(i / 5)}.${i % 5}`, 'ada@example.com'), start)).toBeNull();
		}
		expect(await reserveLoginAttempt(db, loginKeys('198.51.100.9', 'ada@example.com'), start)).not.toBeNull();
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

describe('clientNetwork', () => {
	test('IPv6 addresses in one /64 share a key', () => {
		expect(clientNetwork('2001:db8:abcd:12:1::5')).toBe('2001:db8:abcd:12::/64');
		expect(clientNetwork('2001:0db8:abcd:0012:ffff:ffff:ffff:ffff')).toBe('2001:db8:abcd:12::/64');
		expect(clientNetwork('[2001:db8::1]')).toBe('2001:db8:0:0::/64');
		expect(clientNetwork('fe80::1%en0')).toBe('fe80:0:0:0::/64');
	});

	test('IPv4 and mapped IPv4 stay single addresses', () => {
		expect(clientNetwork('203.0.113.7')).toBe('203.0.113.7');
		expect(clientNetwork('::ffff:203.0.113.7')).toBe('203.0.113.7');
	});

	test('rotating through a /64 does not escape the per-client limit', async () => {
		const db = open();
		const start = new Date('2026-11-03T12:00:00Z');
		const results: (number | null)[] = [];
		for (let i = 1; i <= 11; i++) {
			results.push(await reserveLoginAttempt(db, loginKeys(`2001:db8:1:2::${i.toString(16)}`, 'ada@example.com'), start));
		}
		expect(results.slice(0, 10).every((wait) => wait === null)).toBe(true);
		expect(results[10]).not.toBeNull();
	});
});

describe('trusted devices', () => {
	const start = new Date('2026-11-03T12:00:00Z');

	test('a flood from many IPs blocks new devices but not the owner\'s known one', async () => {
		const db = open();
		const token = await rememberDevice(db, 'Ada@example.com', start);
		for (let i = 0; i < 25; i++) {
			await reserveLoginAttempt(db, loginKeys(`10.1.${i}.1`, 'ada@example.com'), start);
		}
		expect(await reserveLoginAttempt(db, loginKeys('198.51.100.9', 'ada@example.com'), start)).not.toBeNull();

		const device = await knownDevice(db, token, 'ada@example.com', start);
		expect(device).not.toBeNull();
		expect(await reserveLoginAttempt(db, loginKeys('198.51.100.9', 'ada@example.com', device), start)).toBeNull();
	});

	test('a device token only vouches for its own account and expires', async () => {
		const db = open();
		const token = await rememberDevice(db, 'ada@example.com', start);
		expect(await knownDevice(db, token, 'eve@example.com', start)).toBeNull();
		expect(await knownDevice(db, 'forged', 'ada@example.com', start)).toBeNull();
		const later = new Date(start.getTime() + 181 * 24 * 60 * 60 * 1000);
		expect(await knownDevice(db, token, 'ada@example.com', later)).toBeNull();
	});

	test('a known device still has its own limit', async () => {
		const db = open();
		const device = await knownDevice(db, await rememberDevice(db, 'ada@example.com', start), 'ada@example.com', start);
		for (let i = 0; i < 10; i++) {
			expect(await reserveLoginAttempt(db, loginKeys(`10.2.${i}.1`, 'ada@example.com', device), start)).toBeNull();
		}
		expect(await reserveLoginAttempt(db, loginKeys('10.2.99.1', 'ada@example.com', device), start)).not.toBeNull();
	});
});

describe('trusted device revocation', () => {
	const start = new Date('2026-11-03T12:00:00Z');

	test('changing the password retires every trusted device', async () => {
		const db = open();
		const token = await rememberDevice(db, 'ada@example.com', start);
		expect(await knownDevice(db, token, 'ada@example.com', start)).not.toBeNull();
		lastSqlite.run(`UPDATE users SET password_hash = 'salt2:hash-2' WHERE id = 'u1'`);
		expect(await knownDevice(db, token, 'ada@example.com', start)).toBeNull();
	});

	test('an account keeps only its ten newest devices', async () => {
		const db = open();
		const tokens: string[] = [];
		for (let i = 0; i < 12; i++) {
			tokens.push(await rememberDevice(db, 'ada@example.com', new Date(start.getTime() + i * 1000)));
		}
		const later = new Date(start.getTime() + 60_000);
		expect(await knownDevice(db, tokens[0], 'ada@example.com', later)).toBeNull();
		expect(await knownDevice(db, tokens[1], 'ada@example.com', later)).toBeNull();
		expect(await knownDevice(db, tokens[11], 'ada@example.com', later)).not.toBeNull();
	});

	test('all known devices together share a looser account limit', async () => {
		const db = open();
		const devices: (string | null)[] = [];
		for (let i = 0; i < 10; i++) {
			const token = await rememberDevice(db, 'ada@example.com', new Date(start.getTime() + i));
			devices.push(await knownDevice(db, token, 'ada@example.com', start));
		}
		let allowed = 0;
		for (let round = 0; round < 6; round++) {
			for (const device of devices) {
				if ((await reserveLoginAttempt(db, loginKeys(`10.9.${round}.1`, 'ada@example.com', device), start)) === null) allowed++;
			}
		}
		expect(allowed).toBe(50);
	});
});
