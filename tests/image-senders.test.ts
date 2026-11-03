import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { D1Database } from '@cloudflare/workers-types';
import { readVtThreshold, setUserVtThreshold } from '../src/lib/server/auth';
import { DEMO_USER } from '../src/lib/server/demo';
import {
	forgetImageSender,
	listImageSenders,
	rememberImageSender
} from '../src/lib/server/image-senders';
import { PATCH } from '../src/routes/api/preferences/+server';

const SCHEMA = `
CREATE TABLE users (
	id TEXT PRIMARY KEY,
	email TEXT NOT NULL,
	name TEXT NOT NULL
);
CREATE TABLE user_preferences (
	user_id TEXT PRIMARY KEY,
	mail_skin TEXT,
	priority_inbox INTEGER NOT NULL DEFAULT 0,
	undo_send_seconds INTEGER NOT NULL DEFAULT 10,
	vt_malicious_threshold INTEGER NOT NULL DEFAULT 1,
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE trusted_image_senders (
	user_id TEXT NOT NULL,
	address TEXT NOT NULL COLLATE NOCASE,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	PRIMARY KEY (user_id, address)
);
`;

function open() {
	const sqlite = new Database(':memory:');
	sqlite.exec(SCHEMA);
	sqlite.run(`INSERT INTO users (id, email, name) VALUES ('user-1', 'ada@login.test', 'Ada')`);
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

type PreferenceEvent = Parameters<typeof PATCH>[0];

function call(
	body: unknown,
	init: { userId?: string; db: D1Database }
) {
	const request = new Request('http://localhost/api/preferences', {
		method: 'PATCH',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	return PATCH({
		request,
		locals: { user: { id: init.userId ?? 'user-1' } },
		platform: { env: { DB: init.db } },
		cookies: {
			get: () => undefined,
			set: () => {},
			delete: () => {}
		}
	} as PreferenceEvent);
}

test('a blank address is rejected and a saved address round-trips lowercased', async () => {
	const { db } = open();
	expect(await rememberImageSender(db, 'user-1', '  ')).toBe(false);
	expect(await rememberImageSender(db, 'user-1', 'Ada@Example.com')).toBe(true);
	expect(await listImageSenders(db, 'user-1')).toEqual(['ada@example.com']);
	await forgetImageSender(db, 'user-1', 'ada@example.com');
	expect(await listImageSenders(db, 'user-1')).toEqual([]);
});

test('readVtThreshold is 1 when no row exists', async () => {
	const { db } = open();
	expect(await readVtThreshold(db, 'user-1')).toBe(1);
});

test('readVtThreshold is 1 when the stored number is outside 1–70', async () => {
	const { sqlite, db } = open();
	sqlite.run(
		`INSERT INTO user_preferences (user_id, vt_malicious_threshold) VALUES ('user-1', 0)`
	);
	expect(await readVtThreshold(db, 'user-1')).toBe(1);
	sqlite.run(`UPDATE user_preferences SET vt_malicious_threshold = 71 WHERE user_id = 'user-1'`);
	expect(await readVtThreshold(db, 'user-1')).toBe(1);
});

test('setUserVtThreshold of 2 reads back 2', async () => {
	const { db } = open();
	await setUserVtThreshold(db, 'user-1', 2);
	expect(await readVtThreshold(db, 'user-1')).toBe(2);
});

describe('preferences threshold', () => {
	test('PATCH with only vtMaliciousThreshold stores 2', async () => {
		const { db } = open();
		const response = await call({ vtMaliciousThreshold: 2 }, { db });
		expect(response.status).toBe(200);
		expect(await readVtThreshold(db, 'user-1')).toBe(2);
	});

	test('invalid threshold is rejected and leaves a stored 2 unchanged', async () => {
		const { db } = open();
		await setUserVtThreshold(db, 'user-1', 2);
		for (const vtMaliciousThreshold of [0, '2', 1.5]) {
			const response = await call({ vtMaliciousThreshold }, { db });
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ error: 'vtMaliciousThreshold' });
			expect(await readVtThreshold(db, 'user-1')).toBe(2);
		}
	});

	test('a demo user cannot change a valid threshold', async () => {
		const { db } = open();
		await setUserVtThreshold(db, DEMO_USER.id, 2);
		const response = await call(
			{ vtMaliciousThreshold: 3 },
			{ db, userId: DEMO_USER.id }
		);
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: 'Demo mode is read-only' });
		expect(await readVtThreshold(db, DEMO_USER.id)).toBe(2);
	});
});
