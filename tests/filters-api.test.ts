import path from 'node:path';
import { Database } from 'bun:sqlite';
import { describe, expect, spyOn, test } from 'bun:test';
import type { D1Database } from '@cloudflare/workers-types';
import type { EmailProvider } from '../src/lib/server/email-provider';
import {
	FilterNotFoundError,
	FilterWriteError,
	applySavedFilter,
	createFilter,
	deleteFilter,
	listBlockedSenders,
	listFilters,
	removeBlockedSender,
	updateFilter,
	type FilterWriteCode
} from '../src/lib/server/filters-store';
import { DELETE as deleteBlocked, GET as listBlocked } from '../src/routes/api/blocked/+server';
import { POST as applyFilter } from '../src/routes/api/filters/[id]/apply/+server';
import { DELETE, PATCH } from '../src/routes/api/filters/[id]/+server';
import { GET, POST } from '../src/routes/api/filters/+server';

const SCHEMA = `
CREATE TABLE users (
	id TEXT PRIMARY KEY,
	email TEXT NOT NULL UNIQUE,
	name TEXT NOT NULL,
	password_hash TEXT NOT NULL DEFAULT 'x',
	is_admin INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE domains (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
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
	user_id TEXT NOT NULL,
	domain_id TEXT NOT NULL,
	address TEXT NOT NULL UNIQUE,
	label TEXT,
	is_default INTEGER NOT NULL DEFAULT 0,
	signature_html TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE emails (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	direction TEXT NOT NULL,
	from_addr TEXT NOT NULL,
	to_addr TEXT NOT NULL,
	subject TEXT NOT NULL,
	body_text TEXT,
	thread_id TEXT,
	is_read INTEGER NOT NULL DEFAULT 0,
	is_starred INTEGER NOT NULL DEFAULT 0,
	is_spam INTEGER NOT NULL DEFAULT 0,
	in_inbox INTEGER NOT NULL DEFAULT 1,
	category TEXT NOT NULL DEFAULT 'primary',
	is_important INTEGER NOT NULL DEFAULT 0,
	snoozed_until TEXT,
	is_muted INTEGER NOT NULL DEFAULT 0,
	deleted_at TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE email_attachments (
	id TEXT PRIMARY KEY,
	email_id TEXT NOT NULL,
	filename TEXT NOT NULL,
	content_type TEXT NOT NULL,
	size_bytes INTEGER NOT NULL,
	content_base64 TEXT NOT NULL
);
CREATE TABLE labels (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	parent_id TEXT,
	name TEXT NOT NULL,
	color TEXT NOT NULL DEFAULT 'slate',
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE thread_labels (
	user_id TEXT NOT NULL,
	thread_id TEXT NOT NULL,
	label_id TEXT NOT NULL,
	PRIMARY KEY (user_id, thread_id, label_id)
);
CREATE TABLE filters (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	position INTEGER NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1,
	match_from TEXT,
	match_to TEXT,
	match_subject TEXT,
	match_words TEXT,
	match_has_attachment INTEGER NOT NULL DEFAULT 0,
	action_label_id TEXT REFERENCES labels(id) ON DELETE SET NULL,
	action_skip_inbox INTEGER NOT NULL DEFAULT 0,
	action_star INTEGER NOT NULL DEFAULT 0,
	action_important INTEGER NOT NULL DEFAULT 0,
	action_mark_read INTEGER NOT NULL DEFAULT 0,
	action_trash INTEGER NOT NULL DEFAULT 0,
	action_category TEXT,
	action_forward_to TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE blocked_senders (
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	address TEXT NOT NULL COLLATE NOCASE,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	PRIMARY KEY (user_id, address)
);
`;

function open() {
	const sqlite = new Database(':memory:');
	sqlite.exec('PRAGMA foreign_keys = ON');
	sqlite.exec(SCHEMA);
	sqlite.run(
		`INSERT INTO users (id, email, name) VALUES ('user-1', 'ada@login.test', 'Ada'), ('user-2', 'bea@login.test', 'Bea')`
	);
	return { sqlite, db: adapt(sqlite) };
}

function adapt(sqlite: Database): D1Database {
	return {
		prepare(sql: string) {
			return {
				bind(...params: unknown[]) {
					if (params.length > 100) {
						throw new Error(`D1 allows 100 bound parameters, got ${params.length}`);
					}
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
		},
		async batch(statements: Array<{ run(): Promise<unknown> }>) {
			const results = [];
			for (const statement of statements) results.push(await statement.run());
			return results;
		}
	} as unknown as D1Database;
}

function addEmail(
	sqlite: Database,
	row: {
		id: string;
		userId?: string;
		direction?: string;
		from?: string;
		to?: string;
		subject?: string;
		body?: string | null;
		threadId?: string | null;
		spam?: number;
		deletedAt?: string | null;
		createdAt?: string;
	}
) {
	sqlite.run(
		`INSERT INTO emails (
			id, user_id, direction, from_addr, to_addr, subject, body_text, thread_id,
			is_spam, deleted_at, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			row.id,
			row.userId ?? 'user-1',
			row.direction ?? 'inbound',
			row.from ?? 'ada@example.com',
			row.to ?? 'me@cloudmail.test',
			row.subject ?? 'Hello',
			row.body === undefined ? 'plain body' : row.body,
			row.threadId === undefined ? row.id : row.threadId,
			row.spam ?? 0,
			row.deletedAt ?? null,
			row.createdAt ?? '2026-01-02 00:00:00'
		]
	);
}

function addAttachment(sqlite: Database, emailId: string) {
	sqlite.run(
		`INSERT INTO email_attachments (id, email_id, filename, content_type, size_bytes, content_base64)
		 VALUES (?, ?, 'note.txt', 'text/plain', 4, 'aGk=')`,
		[`att-${emailId}`, emailId]
	);
}

function seedSendingIdentity(sqlite: Database) {
	sqlite.run(`INSERT INTO domains (id, name) VALUES ('dom-1', 'cloudmail.test')`);
	sqlite.run(
		`INSERT INTO addresses (id, user_id, domain_id, address, is_default)
		 VALUES ('addr-1', 'user-1', 'dom-1', 'me@cloudmail.test', 1)`
	);
}

function addLabel(sqlite: Database, id: string, userId = 'user-1') {
	sqlite.run(`INSERT INTO labels (id, user_id, name) VALUES (?, ?, ?)`, [id, userId, id]);
}

function starred(sqlite: Database, id: string) {
	const row = sqlite.query(`SELECT is_starred AS starred FROM emails WHERE id = ?`).get(id) as {
		starred: number;
	};
	return row.starred;
}

function provider(send: EmailProvider['send']): EmailProvider {
	return {
		kind: 'resend',
		send,
		async listDomains() {
			return [];
		},
		async getDomain() {
			throw new Error('unused');
		}
	};
}

async function expectCode(promise: Promise<unknown>, code: FilterWriteCode) {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(FilterWriteError);
		expect((error as FilterWriteError).code).toBe(code);
		return;
	}
	throw new Error(`expected ${code}`);
}

describe('filter store', () => {
	test('rejects a filter with no condition, no action, a bad address, category, or label', async () => {
		const { sqlite, db } = open();
		addLabel(sqlite, 'label-bills');
		addLabel(sqlite, 'label-theirs', 'user-2');

		await expectCode(createFilter(db, 'user-1', { actionStar: true }), 'condition');
		await expectCode(
			createFilter(db, 'user-1', { matchFrom: '   ', matchHasAttachment: false, actionStar: true }),
			'condition'
		);
		await expectCode(createFilter(db, 'user-1', { matchFrom: 'ada@' }), 'action');
		await expectCode(
			createFilter(db, 'user-1', { matchFrom: 'ada@', actionForwardTo: 'not-an-email', actionStar: true }),
			'forward'
		);
		await expectCode(
			createFilter(db, 'user-1', { matchFrom: 'ada@', actionForwardTo: 'a@b' }),
			'forward'
		);
		await expectCode(
			createFilter(db, 'user-1', { matchFrom: 'ada@', actionCategory: 'nope', actionStar: true }),
			'category'
		);
		await expectCode(
			createFilter(db, 'user-1', { matchFrom: 'ada@', actionLabelId: 'label-theirs', actionStar: true }),
			'label'
		);
		await expectCode(
			createFilter(db, 'user-1', { matchFrom: 'ada@', actionLabelId: 'missing' }),
			'label'
		);

		const saved = await createFilter(db, 'user-1', {
			matchFrom: '  ada@  ',
			actionForwardTo: ' boss@elsewhere.test ',
			actionCategory: ' promotions ',
			actionLabelId: 'label-bills',
			matchHasAttachment: true
		});
		expect(saved).toMatchObject({
			position: 1,
			enabled: true,
			matchFrom: 'ada@',
			actionForwardTo: 'boss@elsewhere.test',
			actionCategory: 'promotions',
			actionLabelId: 'label-bills',
			matchHasAttachment: true
		});
	});

	test('positions are per user and a patch cannot erase the last condition or action', async () => {
		const { sqlite, db } = open();
		const first = await createFilter(db, 'user-1', { matchSubject: 'Invoice', actionStar: true });
		sqlite.run(
			`INSERT INTO filters (id, user_id, position, match_from, action_star)
			 VALUES ('other', 'user-2', 50, 'ada@', 1)`
		);
		const second = await createFilter(db, 'user-1', {
			matchWords: 'balance',
			actionSkipInbox: true,
			enabled: false
		});
		expect([first.position, second.position]).toEqual([1, 2]);
		expect(second.enabled).toBe(false);

		const listed = await listFilters(db, 'user-1');
		expect(listed.map((filter) => filter.id)).toEqual([first.id, second.id]);
		expect(await listFilters(db, 'user-2')).toEqual([
			expect.objectContaining({ id: 'other', position: 50, actionStar: true })
		]);

		await expectCode(updateFilter(db, 'user-1', first.id, { matchSubject: '   ' }), 'condition');
		await expectCode(updateFilter(db, 'user-1', first.id, { actionStar: false }), 'action');
		expect((await listFilters(db, 'user-1'))[0]).toMatchObject({
			matchSubject: 'Invoice',
			actionStar: true
		});

		const patched = await updateFilter(db, 'user-1', first.id, {
			actionImportant: true,
			actionStar: false,
			enabled: false
		});
		expect(patched).toMatchObject({
			matchSubject: 'Invoice',
			actionStar: false,
			actionImportant: true,
			enabled: false
		});

		await expect(updateFilter(db, 'user-1', 'other', { actionStar: false })).rejects.toBeInstanceOf(
			FilterNotFoundError
		);
		await expect(deleteFilter(db, 'user-1', 'other')).rejects.toBeInstanceOf(FilterNotFoundError);
		await deleteFilter(db, 'user-1', second.id);
		expect((await listFilters(db, 'user-1')).map((filter) => filter.id)).toEqual([first.id]);
		expect(await listFilters(db, 'user-2')).toHaveLength(1);
	});
});

describe('apply saved filter', () => {
	test('dry run counts conversations and writes nothing', async () => {
		const { sqlite, db } = open();
		addEmail(sqlite, { id: 'old', threadId: 'thread-1', createdAt: '2026-01-01 00:00:00' });
		addEmail(sqlite, { id: 'new', threadId: 'thread-1', subject: 'Invoice', createdAt: '2026-01-03 00:00:00' });
		addEmail(sqlite, { id: 'other', threadId: 'thread-2', from: 'bea@example.com' });
		addEmail(sqlite, { id: 'sent', threadId: 'thread-3', direction: 'outbound', from: 'ada@example.com' });
		addEmail(sqlite, { id: 'theirs', userId: 'user-2', threadId: 'thread-4' });
		const filter = await createFilter(db, 'user-1', { matchFrom: 'ada@', actionStar: true });

		const preview = await applySavedFilter(db, 'user-1', filter.id, { dryRun: true });
		expect(preview).toEqual({ matched: 1 });
		for (const id of ['old', 'new', 'other', 'sent', 'theirs']) expect(starred(sqlite, id)).toBe(0);
		await expect(applySavedFilter(db, 'user-1', 'missing', { dryRun: true })).rejects.toBeInstanceOf(
			FilterNotFoundError
		);
	});

	test('applies once per conversation, including spam and trash, and a second run forwards again', async () => {
		const { sqlite, db } = open();
		seedSendingIdentity(sqlite);
		addLabel(sqlite, 'label-bills');
		addEmail(sqlite, {
			id: 'older',
			threadId: 'thread-1',
			subject: 'Invoice',
			body: 'first copy',
			createdAt: '2026-01-01 00:00:00'
		});
		addEmail(sqlite, {
			id: 'newer',
			threadId: 'thread-1',
			subject: 'Invoice paid',
			body: 'second copy',
			createdAt: '2026-01-03 00:00:00'
		});
		addEmail(sqlite, {
			id: 'reply',
			threadId: 'thread-1',
			direction: 'outbound',
			from: 'me@cloudmail.test',
			to: 'ada@example.com',
			subject: 'Re: Invoice',
			createdAt: '2026-01-04 00:00:00'
		});
		addEmail(sqlite, {
			id: 'spam',
			threadId: 'thread-spam',
			subject: 'Invoice spam',
			spam: 1
		});
		addEmail(sqlite, {
			id: 'trash',
			threadId: 'thread-trash',
			subject: 'Invoice trash',
			deletedAt: '2026-01-02 00:00:00'
		});
		addEmail(sqlite, { id: 'skip', threadId: 'thread-skip', from: 'bea@example.com', subject: 'Invoice' });

		const filter = await createFilter(db, 'user-1', {
			matchFrom: 'Ada@',
			matchSubject: 'invoice',
			actionStar: true,
			actionLabelId: 'label-bills',
			actionCategory: 'updates',
			actionForwardTo: 'boss@elsewhere.test',
			enabled: false
		});

		const sent: Array<{ to: string[]; subject: string; text: string; from: string; senderName: string }> = [];
		const send = provider(async (input) => {
			const to = Array.isArray(input.to) ? input.to : [input.to];
			sent.push({
				to,
				subject: input.subject,
				text: input.text,
				from: input.from.address,
				senderName: input.senderName
			});
			return { providerId: `sent-${sent.length}` };
		});

		const first = await applySavedFilter(db, 'user-1', filter.id, { provider: send });
		expect(first).toEqual({ changed: 3, forwardFailed: 0 });
		expect(sent).toEqual([
			{
				to: ['boss@elsewhere.test'],
				subject: 'Fwd: Invoice paid',
				text: 'second copy',
				from: 'me@cloudmail.test',
				senderName: 'Ada'
			},
			{
				to: ['boss@elsewhere.test'],
				subject: 'Fwd: Invoice spam',
				text: 'plain body',
				from: 'me@cloudmail.test',
				senderName: 'Ada'
			},
			{
				to: ['boss@elsewhere.test'],
				subject: 'Fwd: Invoice trash',
				text: 'plain body',
				from: 'me@cloudmail.test',
				senderName: 'Ada'
			}
		]);

		for (const id of ['older', 'newer', 'reply', 'spam', 'trash']) {
			expect(starred(sqlite, id)).toBe(1);
			const row = sqlite.query(`SELECT category FROM emails WHERE id = ?`).get(id) as { category: string };
			expect(row.category).toBe('updates');
		}
		expect(starred(sqlite, 'skip')).toBe(0);
		const labelCount = () =>
			(sqlite.query(`SELECT COUNT(*) AS n FROM thread_labels`).get() as { n: number }).n;
		expect(labelCount()).toBe(3);

		const again = await applySavedFilter(db, 'user-1', filter.id, { provider: send });
		expect(again).toEqual({ changed: 3, forwardFailed: 0 });
		expect(sent).toHaveLength(6);
		expect(labelCount()).toBe(3);
	});

	test('matches words in the subject or body, and the attachment flag only when it is on', async () => {
		const { sqlite, db } = open();
		addEmail(sqlite, {
			id: 'subject',
			threadId: 't-subject',
			from: 'news@letters.test',
			subject: 'Balance due',
			body: 'hello'
		});
		addEmail(sqlite, {
			id: 'body',
			threadId: 't-body',
			from: 'news@letters.test',
			subject: 'Hello',
			body: 'your BALANCE is ready'
		});
		addEmail(sqlite, {
			id: 'neither',
			threadId: 't-neither',
			from: 'news@letters.test',
			subject: 'Hello',
			body: 'nothing here'
		});
		addEmail(sqlite, { id: 'file', threadId: 't-file', from: 'ada@example.com', subject: 'Hello' });
		addEmail(sqlite, { id: 'nofile', threadId: 't-nofile', from: 'ada@example.com', subject: 'Hello' });
		addEmail(sqlite, { id: 'other-file', threadId: 't-other', from: 'bea@example.com', subject: 'Hello' });
		addAttachment(sqlite, 'file');
		addAttachment(sqlite, 'other-file');

		const words = await createFilter(db, 'user-1', { matchWords: 'balance', actionMarkRead: true });
		expect(await applySavedFilter(db, 'user-1', words.id, { dryRun: true })).toEqual({ matched: 2 });

		const files = await createFilter(db, 'user-1', {
			matchFrom: 'ada@',
			matchHasAttachment: true,
			actionStar: true
		});
		const applied = await applySavedFilter(db, 'user-1', files.id);
		expect(applied).toEqual({ changed: 1, forwardFailed: 0 });
		expect(starred(sqlite, 'file')).toBe(1);
		expect(starred(sqlite, 'nofile')).toBe(0);
		expect(starred(sqlite, 'other-file')).toBe(0);

		const anyAda = await createFilter(db, 'user-1', { matchFrom: 'ada@', actionImportant: true });
		expect(await applySavedFilter(db, 'user-1', anyAda.id)).toEqual({ changed: 2, forwardFailed: 0 });
	});

	test('a failed forward is counted and does not stop the next conversation', async () => {
		const { sqlite, db } = open();
		seedSendingIdentity(sqlite);
		addEmail(sqlite, { id: 'one', threadId: 't-one', subject: 'Older', createdAt: '2026-01-01 00:00:00' });
		addEmail(sqlite, { id: 'two', threadId: 't-two', subject: 'Newer', createdAt: '2026-01-02 00:00:00' });
		const filter = await createFilter(db, 'user-1', {
			matchFrom: 'ada@',
			actionStar: true,
			actionForwardTo: 'boss@elsewhere.test'
		});
		const sent: string[] = [];
		const errors = spyOn(console, 'error').mockImplementation(() => {});

		try {
			const result = await applySavedFilter(db, 'user-1', filter.id, {
				provider: provider(async (input) => {
					if (input.subject === 'Fwd: Older') throw new Error('smtp down');
					sent.push(input.subject);
					return { providerId: 'ok' };
				})
			});
			expect(result).toEqual({ changed: 2, forwardFailed: 1 });
			expect(sent).toEqual(['Fwd: Newer']);
			expect(starred(sqlite, 'one')).toBe(1);
			expect(starred(sqlite, 'two')).toBe(1);
			expect(errors.mock.calls.some((call) => call[0] === 'Failed to forward inbound mail')).toBe(true);

			errors.mockClear();
			const nobody = await createFilter(db, 'user-2', {
				matchFrom: 'ada@',
				actionForwardTo: 'boss@elsewhere.test'
			});
			expect(await applySavedFilter(db, 'user-2', nobody.id)).toEqual({ changed: 0, forwardFailed: 0 });

			const withMail = await createFilter(db, 'user-1', {
				matchTo: 'me@cloudmail.test',
				actionForwardTo: 'boss@elsewhere.test'
			});
			const noProvider = await applySavedFilter(db, 'user-1', withMail.id);
			expect(noProvider.changed).toBe(2);
			expect(noProvider.forwardFailed).toBe(2);
			expect(errors.mock.calls.some((call) => String(call[2]).includes('No sending provider'))).toBe(
				true
			);

			errors.mockClear();
			sqlite.run(`DELETE FROM addresses`);
			const noAddress = await applySavedFilter(db, 'user-1', filter.id, {
				provider: provider(async () => {
					throw new Error('should not send');
				})
			});
			expect(noAddress).toEqual({ changed: 2, forwardFailed: 2 });
			expect(errors.mock.calls.some((call) => String(call[2]).includes('No sending address'))).toBe(
				true
			);
		} finally {
			errors.mockRestore();
		}
	});

	test('chunks an apply that would otherwise bind more than 100 parameters', async () => {
		const { sqlite, db } = open();
		for (let index = 0; index < 101; index += 1) {
			const id = `m-${String(index).padStart(3, '0')}`;
			addEmail(sqlite, { id, threadId: id, subject: 'File' });
			addAttachment(sqlite, id);
		}
		addEmail(sqlite, { id: 'plain', threadId: 'plain', subject: 'File' });

		const filter = await createFilter(db, 'user-1', {
			matchHasAttachment: true,
			matchSubject: 'file',
			actionStar: true
		});
		const result = await applySavedFilter(db, 'user-1', filter.id);
		expect(result).toEqual({ changed: 101, forwardFailed: 0 });
		expect(starred(sqlite, 'plain')).toBe(0);
		expect(starred(sqlite, 'm-000')).toBe(1);
		expect(starred(sqlite, 'm-100')).toBe(1);
	});
});

describe('blocked senders', () => {
	test('lists addresses and removes one without touching another user', async () => {
		const { sqlite, db } = open();
		sqlite.run(
			`INSERT INTO blocked_senders (user_id, address, created_at) VALUES
			 ('user-1', 'ada@example.com', '2026-01-01 00:00:00'),
			 ('user-1', 'bea@example.com', '2026-01-02 00:00:00'),
			 ('user-2', 'ada@example.com', '2026-01-03 00:00:00')`
		);

		expect(await listBlockedSenders(db, 'user-1')).toEqual([
			{ address: 'ada@example.com', createdAt: '2026-01-01 00:00:00' },
			{ address: 'bea@example.com', createdAt: '2026-01-02 00:00:00' }
		]);

		expect(await removeBlockedSender(db, 'user-1', 'Ada <ada@example.com>')).toBe(true);
		expect(await listBlockedSenders(db, 'user-1')).toEqual([
			{ address: 'bea@example.com', createdAt: '2026-01-02 00:00:00' }
		]);
		expect(await listBlockedSenders(db, 'user-2')).toEqual([
			{ address: 'ada@example.com', createdAt: '2026-01-03 00:00:00' }
		]);
		expect(await removeBlockedSender(db, 'user-1', 'example.com')).toBe(false);
		expect(await removeBlockedSender(db, 'user-1', 'gone@example.com')).toBe(true);
	});
});

type HandlerEvent = Parameters<typeof POST>[0];

function call(
	handler: (event: HandlerEvent) => ReturnType<typeof POST>,
	init: {
		method?: string;
		body?: unknown;
		raw?: string;
		user?: { id: string } | null;
		db?: D1Database | null;
		params?: { id: string };
		url?: string;
	}
) {
	const hasRaw = init.raw !== undefined;
	const hasBody = init.body !== undefined;
	const request = new Request(init.url ?? 'http://localhost/api/filters', {
		method: init.method ?? 'GET',
		headers: hasBody || hasRaw ? { 'content-type': 'application/json' } : undefined,
		body: hasRaw ? init.raw : hasBody ? JSON.stringify(init.body) : undefined
	});
	return handler({
		request,
		locals: { user: init.user === undefined ? { id: 'user-1' } : init.user },
		platform: init.db ? { env: { DB: init.db } } : undefined,
		params: init.params ?? {},
		url: new URL(request.url)
	} as HandlerEvent);
}

describe('filter and block routes', () => {
	test('saves, edits, applies, lists blocked senders, and removes one', async () => {
		const { sqlite, db } = open();
		addLabel(sqlite, 'label-bills');
		addEmail(sqlite, { id: 'old', threadId: 'thread-1', createdAt: '2026-01-01 00:00:00' });
		addEmail(sqlite, { id: 'new', threadId: 'thread-1', createdAt: '2026-01-02 00:00:00' });
		addEmail(sqlite, { id: 'solo', threadId: 'solo', from: 'bea@example.com' });

		expect((await call(GET, { user: null, db })).status).toBe(401);
		expect((await call(POST, { body: { matchFrom: 'ada@', actionStar: true }, db: null })).status).toBe(
			401
		);

		const bad = await call(POST, { db, body: { actionStar: true } });
		expect(bad.status).toBe(400);
		expect(await bad.json()).toEqual({ error: 'condition' });

		const badForward = await call(POST, {
			db,
			body: { matchFrom: 'ada@', actionForwardTo: 'a@b.c o' }
		});
		expect(badForward.status).toBe(400);
		expect(await badForward.json()).toEqual({ error: 'forward' });

		const badType = await call(POST, { db, body: { matchFrom: 'ada@', actionStar: 'yes' } });
		expect(badType.status).toBe(400);
		expect(await badType.json()).toEqual({ error: 'Bad request' });

		const created = await call(POST, {
			db,
			body: { matchFrom: 'ada@', actionStar: true, actionLabelId: 'label-bills' }
		});
		expect(created.status).toBe(201);
		const { filter } = (await created.json()) as { filter: { id: string; position: number } };
		expect(filter.position).toBe(1);

		const listed = await call(GET, { db });
		expect(listed.status).toBe(200);
		expect(((await listed.json()) as { filters: { id: string }[] }).filters.map((item) => item.id)).toEqual([
			filter.id
		]);

		const patched = await call(PATCH, {
			db,
			method: 'PATCH',
			params: { id: filter.id },
			body: { actionImportant: true }
		});
		expect(patched.status).toBe(200);
		expect(await patched.json()).toEqual({
			filter: expect.objectContaining({ id: filter.id, actionStar: true, actionImportant: true })
		});

		const preview = await call(applyFilter, {
			db,
			method: 'POST',
			url: `http://localhost/api/filters/${filter.id}/apply`,
			params: { id: filter.id },
			body: { dryRun: true }
		});
		expect(preview.status).toBe(200);
		expect(await preview.json()).toEqual({ matched: 1 });
		expect(starred(sqlite, 'old')).toBe(0);
		expect(starred(sqlite, 'new')).toBe(0);

		const applied = await call(applyFilter, {
			db,
			method: 'POST',
			params: { id: filter.id },
			body: { applyToExisting: true }
		});
		expect(applied.status).toBe(200);
		expect(await applied.json()).toEqual({ changed: 1, forwardFailed: 0 });
		expect(starred(sqlite, 'old')).toBe(1);
		expect(starred(sqlite, 'new')).toBe(1);
		expect(starred(sqlite, 'solo')).toBe(0);

		const empty = await call(applyFilter, {
			db,
			method: 'POST',
			params: { id: filter.id },
			raw: ''
		});
		expect(empty.status).toBe(200);
		expect(await empty.json()).toEqual({ changed: 1, forwardFailed: 0 });

		const junk = await call(applyFilter, {
			db,
			method: 'POST',
			params: { id: 'missing' },
			raw: '{nope'
		});
		expect(junk.status).toBe(400);

		const missing = await call(applyFilter, {
			db,
			method: 'POST',
			params: { id: 'missing' },
			body: { dryRun: true }
		});
		expect(missing.status).toBe(404);

		sqlite.run(
			`INSERT INTO blocked_senders (user_id, address, created_at)
			 VALUES ('user-1', 'spam@evil.test', '2026-01-01 00:00:00')`
		);
		const blocked = await call(listBlocked, { db, url: 'http://localhost/api/blocked' });
		expect(blocked.status).toBe(200);
		expect(await blocked.json()).toEqual([
			{ address: 'spam@evil.test', createdAt: '2026-01-01 00:00:00' }
		]);

		const removed = await call(deleteBlocked, {
			db,
			method: 'DELETE',
			url: 'http://localhost/api/blocked',
			body: { address: 'spam@evil.test' }
		});
		expect(removed.status).toBe(200);
		expect(await removed.json()).toEqual({ ok: true });
		expect(await listBlockedSenders(db, 'user-1')).toEqual([]);

		const domain = await call(deleteBlocked, {
			db,
			method: 'DELETE',
			body: { address: 'evil.test' }
		});
		expect(domain.status).toBe(400);

		const gone = await call(DELETE, { db, method: 'DELETE', params: { id: filter.id } });
		expect(gone.status).toBe(200);
		expect(await gone.json()).toEqual({ ok: true });
		const again = await call(DELETE, { db, method: 'DELETE', params: { id: filter.id } });
		expect(again.status).toBe(404);
	});
});

test('demo mode rejects filter and block writes and still lists', async () => {
	const script = `
		const filters = await import('./src/routes/api/filters/+server.ts');
		const one = await import('./src/routes/api/filters/[id]/+server.ts');
		const apply = await import('./src/routes/api/filters/[id]/apply/+server.ts');
		const blocked = await import('./src/routes/api/blocked/+server.ts');
		const user = { id: 'demo-user-1' };
		const event = (method, body, params, url) => ({
			locals: { user },
			params: params ?? {},
			platform: {},
			url: new URL(url ?? 'http://localhost/api/filters'),
			request: new Request(url ?? 'http://localhost/api/filters', {
				method,
				headers: body ? { 'content-type': 'application/json' } : undefined,
				body: body ? JSON.stringify(body) : undefined
			})
		});
		const post = await filters.POST(event('POST', { matchFrom: 'ada@', actionStar: true }));
		const patch = await one.PATCH(event('PATCH', { actionStar: false }, { id: 'x' }));
		const del = await one.DELETE(event('DELETE', null, { id: 'x' }));
		const run = await apply.POST(event('POST', { dryRun: true }, { id: 'x' }, 'http://localhost/api/filters/x/apply'));
		const unblock = await blocked.DELETE(event('DELETE', { address: 'ada@example.com' }, {}, 'http://localhost/api/blocked'));
		const get = await filters.GET(event('GET'));
		const listedBlocked = await blocked.GET(event('GET', null, {}, 'http://localhost/api/blocked'));
		const filtersBody = await get.json();
		const blockedBody = await listedBlocked.json();
		const writes = [post, patch, del, run, unblock];
		const errors = await Promise.all(writes.map((response) => response.json()));
		if (writes.some((response) => response.status !== 403)) {
			throw new Error('write status ' + writes.map((response) => response.status).join(','));
		}
		if (errors.some((body) => body.error !== 'Demo mode is read-only')) {
			throw new Error('write body ' + JSON.stringify(errors));
		}
		if (get.status !== 200 || !Array.isArray(filtersBody.filters) || filtersBody.filters.length !== 0) {
			throw new Error('filters ' + get.status + ' ' + JSON.stringify(filtersBody));
		}
		if (listedBlocked.status !== 200 || !Array.isArray(blockedBody) || blockedBody.length !== 0) {
			throw new Error('blocked ' + listedBlocked.status + ' ' + JSON.stringify(blockedBody));
		}
		console.log('ok');
	`;

	const proc = Bun.spawn(['bun', '-e', script], {
		cwd: path.join(import.meta.dir, '..'),
		env: { ...process.env, DEMO_MODE: 'true' },
		stdout: 'pipe',
		stderr: 'pipe'
	});
	const [code, out, err] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text()
	]);
	if (code !== 0) throw new Error(err || out);
	expect(out.trim()).toBe('ok');
});
