import path from 'node:path';
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { D1Database } from '@cloudflare/workers-types';
import { LABEL_COLORS } from '../src/lib/organizing/labels';
import {
	LabelNotFoundError,
	LabelWriteError,
	createLabel,
	deleteLabel,
	listLabels,
	updateLabel,
	type LabelWriteCode
} from '../src/lib/server/labels-store';
import { DELETE, PATCH } from '../src/routes/api/labels/[id]/+server';
import { GET, POST } from '../src/routes/api/labels/+server';

const SCHEMA = `
CREATE TABLE users (id TEXT PRIMARY KEY);
CREATE TABLE emails (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	thread_id TEXT,
	is_read INTEGER NOT NULL DEFAULT 0,
	is_spam INTEGER NOT NULL DEFAULT 0,
	deleted_at TEXT
);
CREATE TABLE labels (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	parent_id TEXT REFERENCES labels(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	color TEXT NOT NULL DEFAULT 'slate',
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_labels_sibling ON labels(user_id, ifnull(parent_id, ''), name COLLATE NOCASE);
CREATE TABLE thread_labels (
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	thread_id TEXT NOT NULL,
	label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
	PRIMARY KEY (user_id, thread_id, label_id)
);
`;

function open(userIds: string[] = ['user-1']) {
	const sqlite = new Database(':memory:');
	sqlite.exec('PRAGMA foreign_keys = ON');
	sqlite.exec(SCHEMA);
	for (const id of userIds) sqlite.run('INSERT INTO users (id) VALUES (?)', [id]);
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

function addEmail(
	sqlite: Database,
	row: {
		id: string;
		userId?: string;
		threadId: string | null;
		isRead?: number;
		isSpam?: number;
		deletedAt?: string | null;
	}
) {
	sqlite.run(
		`INSERT INTO emails (id, user_id, thread_id, is_read, is_spam, deleted_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		[
			row.id,
			row.userId ?? 'user-1',
			row.threadId,
			row.isRead ?? 0,
			row.isSpam ?? 0,
			row.deletedAt ?? null
		]
	);
}

function tag(sqlite: Database, threadId: string, labelId: string, userId = 'user-1') {
	sqlite.run('INSERT INTO thread_labels (user_id, thread_id, label_id) VALUES (?, ?, ?)', [
		userId,
		threadId,
		labelId
	]);
}

function count(sqlite: Database, table: 'labels' | 'thread_labels' | 'emails') {
	const row = sqlite.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
	return Number(row.n);
}

async function expectCode(promise: Promise<unknown>, code: LabelWriteCode) {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(LabelWriteError);
		expect((error as LabelWriteError).code).toBe(code);
		return;
	}
	throw new Error(`expected ${code}`);
}

describe('label store', () => {
	test('creates, nests, recolors, and moves without counting child mail as the parent', async () => {
		const { sqlite, db } = open();
		const work = await createLabel(db, 'user-1', { name: '  Work  ', parentId: null, color: 'blue' });
		expect(work).toMatchObject({ name: 'Work', parentId: null, color: 'blue', unread: 0 });

		const clients = await createLabel(db, 'user-1', {
			name: 'Clients',
			parentId: work.id,
			color: 'green'
		});
		await expectCode(updateLabel(db, 'user-1', work.id, { parentId: clients.id }), 'cycle');
		await expectCode(updateLabel(db, 'user-1', work.id, { parentId: work.id }), 'cycle');

		const alsoWork = await createLabel(db, 'user-1', {
			name: 'Work',
			parentId: clients.id,
			color: 'amber'
		});
		expect(alsoWork.parentId).toBe(clients.id);

		await expectCode(
			createLabel(db, 'user-1', { name: 'work', parentId: null, color: 'red' }),
			'duplicate'
		);
		await expectCode(
			createLabel(db, 'user-1', { name: '   ', parentId: null, color: 'red' }),
			'duplicate'
		);
		await expectCode(
			createLabel(db, 'user-1', { name: 'Personal', parentId: null, color: 'purple' }),
			'color'
		);
		await expectCode(
			createLabel(db, 'user-1', { name: 'Personal', parentId: 'missing', color: 'slate' }),
			'parent'
		);

		addEmail(sqlite, { id: 'm-unread', threadId: 't-unread' });
		addEmail(sqlite, { id: 'm-read', threadId: 't-read', isRead: 1 });
		addEmail(sqlite, { id: 'm-spam', threadId: 't-spam', isSpam: 1 });
		addEmail(sqlite, { id: 'm-trash', threadId: 't-trash', deletedAt: '2026-10-30 00:00:00' });
		addEmail(sqlite, { id: 'm-two-a', threadId: 't-two' });
		addEmail(sqlite, { id: 'm-two-b', threadId: 't-two' });
		addEmail(sqlite, { id: 'm-mixed-spam', threadId: 't-mixed', isSpam: 1 });
		addEmail(sqlite, { id: 'm-mixed-clean', threadId: 't-mixed' });
		addEmail(sqlite, { id: 'm-child', threadId: 't-child' });
		addEmail(sqlite, { id: 'm-both', threadId: 't-both' });
		addEmail(sqlite, { id: 'solo', threadId: null });
		addEmail(sqlite, {
			id: 'm-trash-unread',
			threadId: 't-read-and-trash',
			deletedAt: '2026-10-30 00:00:00'
		});
		addEmail(sqlite, { id: 'm-read-clean', threadId: 't-read-and-trash', isRead: 1 });

		for (const threadId of ['t-unread', 't-read', 't-spam', 't-trash', 't-two', 't-mixed', 't-both', 'solo']) {
			tag(sqlite, threadId, work.id);
		}
		tag(sqlite, 't-read-and-trash', work.id);
		tag(sqlite, 't-child', clients.id);
		tag(sqlite, 't-both', clients.id);

		const listed = await listLabels(db, 'user-1');
		const unread = Object.fromEntries(listed.map((label) => [label.id, label.unread]));
		// t-unread, t-two, t-mixed, t-both, solo. Not the child-only thread, read, spam, or trash.
		expect(unread[work.id]).toBe(5);
		expect(unread[clients.id]).toBe(2);
		expect(unread[alsoWork.id]).toBe(0);
		expect((await listLabels(db, 'user-1')).find((label) => label.id === work.id)?.parentId).toBeNull();

		const renamed = await updateLabel(db, 'user-1', work.id, { color: 'pink' });
		expect(renamed).toMatchObject({ name: 'Work', color: 'pink', unread: 5, parentId: null });

		const moved = await updateLabel(db, 'user-1', clients.id, { parentId: null, name: 'Accounts' });
		expect(moved).toMatchObject({ name: 'Accounts', parentId: null, color: 'green', unread: 2 });
	});

	test('rejects the sixth level and a move whose descendant would pass level five', async () => {
		const { db } = open();
		let parent: string | null = null;
		const ids: string[] = [];
		for (const name of ['A', 'B', 'C', 'D', 'E']) {
			const label = await createLabel(db, 'user-1', { name, parentId: parent, color: 'slate' });
			ids.push(label.id);
			parent = label.id;
		}
		await expectCode(
			createLabel(db, 'user-1', { name: 'F', parentId: ids[4], color: 'slate' }),
			'depth'
		);

		const x = await createLabel(db, 'user-1', { name: 'X', parentId: null, color: 'red' });
		const y = await createLabel(db, 'user-1', { name: 'Y', parentId: x.id, color: 'red' });
		await expectCode(updateLabel(db, 'user-1', ids[1], { parentId: y.id }), 'depth');
		const moved = await updateLabel(db, 'user-1', ids[3], { parentId: y.id });
		expect(moved.parentId).toBe(y.id);
		expect((await listLabels(db, 'user-1')).find((label) => label.id === ids[4])?.parentId).toBe(ids[3]);
	});

	test('accepts every label color and nothing else', async () => {
		const { db } = open();
		for (const color of LABEL_COLORS) {
			const label = await createLabel(db, 'user-1', { name: color, parentId: null, color });
			expect(label.color).toBe(color);
		}
		for (const color of ['purple', 'Slate', 'BLUE', '']) {
			await expectCode(createLabel(db, 'user-1', { name: color || 'blank', parentId: null, color }), 'color');
		}
	});

	test('delete removes sublabels and memberships and leaves the message', async () => {
		const { sqlite, db } = open(['user-1', 'user-2']);
		const parent = await createLabel(db, 'user-1', { name: 'Parent', parentId: null, color: 'violet' });
		const child = await createLabel(db, 'user-1', { name: 'Child', parentId: parent.id, color: 'violet' });
		const grandchild = await createLabel(db, 'user-1', {
			name: 'Grandchild',
			parentId: child.id,
			color: 'violet'
		});
		const other = await createLabel(db, 'user-2', { name: 'Parent', parentId: null, color: 'slate' });
		addEmail(sqlite, { id: 'kept', threadId: 'kept-thread' });
		tag(sqlite, 'kept-thread', parent.id);
		tag(sqlite, 'kept-thread', grandchild.id);

		await expect(deleteLabel(db, 'user-1', other.id)).rejects.toBeInstanceOf(LabelNotFoundError);
		expect(count(sqlite, 'labels')).toBe(4);

		await deleteLabel(db, 'user-1', child.id);
		expect((await listLabels(db, 'user-1')).map((label) => label.name)).toEqual(['Parent']);
		expect(count(sqlite, 'emails')).toBe(1);

		await deleteLabel(db, 'user-1', parent.id);
		expect(await listLabels(db, 'user-1')).toEqual([]);
		expect(await listLabels(db, 'user-2')).toEqual([
			expect.objectContaining({ id: other.id, name: 'Parent', unread: 0 })
		]);
		expect(count(sqlite, 'labels')).toBe(1);
		expect(count(sqlite, 'thread_labels')).toBe(0);
		expect(count(sqlite, 'emails')).toBe(1);
		await expect(deleteLabel(db, 'user-1', parent.id)).rejects.toBeInstanceOf(LabelNotFoundError);
	});
});

type HandlerEvent = Parameters<typeof POST>[0];

function call(
	handler: (event: HandlerEvent) => ReturnType<typeof POST>,
	init: {
		method?: string;
		body?: unknown;
		user?: { id: string } | null;
		db?: D1Database | null;
		params?: { id: string };
	}
) {
	const hasBody = init.body !== undefined;
	const request = new Request('http://localhost/api/labels', {
		method: init.method ?? 'GET',
		headers: hasBody ? { 'content-type': 'application/json' } : undefined,
		body: hasBody ? JSON.stringify(init.body) : undefined
	});
	return handler({
		request,
		locals: { user: init.user === undefined ? { id: 'user-1' } : init.user },
		platform: init.db ? { env: { DB: init.db } } : undefined,
		params: init.params ?? {},
		url: new URL(request.url)
	} as HandlerEvent);
}

describe('label routes', () => {
	test('requires a user, creates, lists, edits, and deletes', async () => {
		const { db } = open();
		const missing = await call(GET, { user: null, db });
		expect(missing.status).toBe(401);

		const noDb = await call(POST, { body: { name: 'Work', color: 'blue' }, db: null });
		expect(noDb.status).toBe(401);

		const badColor = await call(POST, { db, body: { name: 'Work', color: 'purple' } });
		expect(badColor.status).toBe(400);
		expect(await badColor.json()).toEqual({ error: 'color' });

		const created = await call(POST, { db, body: { name: 'Work', color: 'blue' } });
		expect(created.status).toBe(201);
		const { label } = (await created.json()) as { label: { id: string; name: string; unread: number } };
		expect(label).toMatchObject({ name: 'Work', parentId: null, color: 'blue', unread: 0 });

		const duplicate = await call(POST, { db, body: { name: 'WORK', parentId: null, color: 'red' } });
		expect(duplicate.status).toBe(400);
		expect(await duplicate.json()).toEqual({ error: 'duplicate' });

		const nested = await call(POST, {
			db,
			body: { name: 'Clients', parentId: label.id, color: 'green' }
		});
		expect(nested.status).toBe(201);
		const child = ((await nested.json()) as { label: { id: string } }).label;

		const listed = await call(GET, { db });
		expect(listed.status).toBe(200);
		const body = (await listed.json()) as { labels: { id: string }[] };
		expect(body.labels.map((item) => item.id).sort()).toEqual([label.id, child.id].sort());

		const recolored = await call(PATCH, {
			db,
			method: 'PATCH',
			params: { id: label.id },
			body: { color: 'orange' }
		});
		expect(recolored.status).toBe(200);
		expect(await recolored.json()).toEqual({
			label: expect.objectContaining({ id: label.id, color: 'orange', name: 'Work' })
		});

		const cycle = await call(PATCH, {
			db,
			method: 'PATCH',
			params: { id: label.id },
			body: { parentId: child.id }
		});
		expect(cycle.status).toBe(400);
		expect(await cycle.json()).toEqual({ error: 'cycle' });

		const badParent = await call(PATCH, {
			db,
			method: 'PATCH',
			params: { id: child.id },
			body: { parentId: '' }
		});
		expect(badParent.status).toBe(400);
		expect(await badParent.json()).toEqual({ error: 'parent' });

		const removed = await call(DELETE, { db, method: 'DELETE', params: { id: label.id } });
		expect(removed.status).toBe(200);
		expect(await removed.json()).toEqual({ ok: true });
		expect(await listLabels(db, 'user-1')).toEqual([]);

		const gone = await call(DELETE, { db, method: 'DELETE', params: { id: label.id } });
		expect(gone.status).toBe(404);
		expect(await gone.json()).toEqual({ error: 'Not found' });
	});
});

test('demo mode rejects label writes and still lists', async () => {
	const script = `
		const { GET, POST } = await import('./src/routes/api/labels/+server.ts');
		const { PATCH, DELETE } = await import('./src/routes/api/labels/[id]/+server.ts');
		const user = { id: 'demo-user-1' };
		const event = (method, body, params) => ({
			locals: { user },
			params: params ?? {},
			platform: {},
			request: new Request('http://localhost/api/labels', {
				method,
				headers: body ? { 'content-type': 'application/json' } : undefined,
				body: body ? JSON.stringify(body) : undefined
			})
		});
		const post = await POST(event('POST', { name: 'Work', parentId: null, color: 'blue' }));
		const patch = await PATCH(event('PATCH', { name: 'Work' }, { id: 'x' }));
		const del = await DELETE(event('DELETE', null, { id: 'x' }));
		const get = await GET(event('GET'));
		const listed = await get.json();
		const errors = await Promise.all([post.json(), patch.json(), del.json()]);
		if (post.status !== 403 || patch.status !== 403 || del.status !== 403) {
			throw new Error('write status ' + [post.status, patch.status, del.status].join(','));
		}
		if (errors.some((body) => body.error !== 'Demo mode is read-only')) {
			throw new Error('write body ' + JSON.stringify(errors));
		}
		if (get.status !== 200 || !Array.isArray(listed.labels) || listed.labels.length === 0) {
			throw new Error('list ' + get.status + ' ' + JSON.stringify(listed));
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
