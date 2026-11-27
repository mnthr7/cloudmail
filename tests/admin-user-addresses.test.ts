import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { D1Database } from '@cloudflare/workers-types';
import { POST } from '../src/routes/api/admin/users/[id]/addresses/+server';

const SCHEMA = `
CREATE TABLE users (
	id TEXT PRIMARY KEY,
	email TEXT NOT NULL UNIQUE COLLATE NOCASE,
	name TEXT NOT NULL,
	is_admin INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE domains (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE COLLATE NOCASE,
	status TEXT NOT NULL DEFAULT 'verified',
	region TEXT,
	sending_enabled INTEGER NOT NULL DEFAULT 1,
	receiving_enabled INTEGER NOT NULL DEFAULT 1,
	catchall_user_id TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	synced_at TEXT
);
CREATE TABLE addresses (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
	address TEXT NOT NULL UNIQUE COLLATE NOCASE,
	label TEXT,
	is_default INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	signature_html TEXT
);
`;

function open() {
	const sqlite = new Database(':memory:');
	sqlite.exec('PRAGMA foreign_keys = ON');
	sqlite.exec(SCHEMA);
	sqlite.run(`INSERT INTO users (id, email, name, is_admin) VALUES ('admin', 'ada@old.test', 'Ada', 1)`);
	sqlite.run(`INSERT INTO users (id, email, name) VALUES ('bea', 'bea@old.test', 'Bea')`);
	sqlite.run(`INSERT INTO domains (id, name) VALUES ('d-old', 'old.test'), ('d-new', 'new.test')`);
	sqlite.run(
		`INSERT INTO addresses (id, user_id, domain_id, address, is_default)
		 VALUES ('a1', 'admin', 'd-old', 'ada@old.test', 1), ('a2', 'bea', 'd-old', 'bea@old.test', 1)`
	);
	return { sqlite, db: adapt(sqlite) };
}

function adapt(sqlite: Database): D1Database {
	return {
		prepare(sql: string) {
			return {
				bind(...params: unknown[]) {
					const values = params.map((value) => (value === undefined ? null : value));
					return {
						async all() {
							return { results: sqlite.query(sql).all(...(values as never[])), success: true, meta: {} };
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

type HandlerEvent = Parameters<typeof POST>[0];

function call(
	db: D1Database,
	init: { userId: string; body: unknown; as?: { id: string; is_admin: boolean } | null }
) {
	const request = new Request(`http://localhost/api/admin/users/${init.userId}/addresses`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(init.body)
	});
	return POST({
		request,
		locals: { user: init.as === undefined ? { id: 'admin', is_admin: true } : init.as },
		platform: { env: { DB: db } },
		params: { id: init.userId },
		url: new URL(request.url)
	} as unknown as HandlerEvent);
}

function addressesOf(sqlite: Database, userId: string) {
	return sqlite
		.query('SELECT address, is_default FROM addresses WHERE user_id = ? ORDER BY address')
		.all(userId) as Array<{ address: string; is_default: number }>;
}

describe('admin: add an address to an existing user', () => {
	test('attaches the address without creating a user or moving the default', async () => {
		const { sqlite, db } = open();
		const res = await call(db, { userId: 'admin', body: { localPart: 'Ada', domainId: 'd-new' } });

		expect(res.status).toBe(201);
		expect(addressesOf(sqlite, 'admin')).toEqual([
			{ address: 'ada@new.test', is_default: 0 },
			{ address: 'ada@old.test', is_default: 1 }
		]);
		expect((sqlite.query('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(2);
	});

	test('works for another user, and allows role addresses', async () => {
		const { sqlite, db } = open();
		const res = await call(db, { userId: 'bea', body: { localPart: 'hello', domainId: 'd-new' } });

		expect(res.status).toBe(201);
		expect(addressesOf(sqlite, 'bea').map((row) => row.address)).toContain('hello@new.test');
	});

	test('refuses an address someone already has', async () => {
		const { sqlite, db } = open();
		const res = await call(db, { userId: 'admin', body: { localPart: 'bea', domainId: 'd-old' } });

		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain('already taken');
		expect(addressesOf(sqlite, 'admin')).toHaveLength(1);
	});

	test('rejects non-admins, unknown users, unknown domains, and missing fields', async () => {
		const { sqlite, db } = open();

		const asMember = await call(db, {
			userId: 'bea',
			body: { localPart: 'x', domainId: 'd-new' },
			as: { id: 'bea', is_admin: false }
		});
		expect(asMember.status).toBe(403);

		const signedOut = await call(db, { userId: 'bea', body: { localPart: 'x', domainId: 'd-new' }, as: null });
		expect(signedOut.status).toBe(403);

		const noUser = await call(db, { userId: 'ghost', body: { localPart: 'x', domainId: 'd-new' } });
		expect(noUser.status).toBe(404);

		const noDomain = await call(db, { userId: 'bea', body: { localPart: 'x', domainId: 'd-gone' } });
		expect(noDomain.status).toBe(400);

		const missing = await call(db, { userId: 'bea', body: { domainId: 'd-new' } });
		expect(missing.status).toBe(400);

		expect(addressesOf(sqlite, 'bea')).toHaveLength(1);
	});
});
