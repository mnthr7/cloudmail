import path from 'node:path';
import { Database } from 'bun:sqlite';
import { describe, expect, spyOn, test } from 'bun:test';
import type { D1Database } from '@cloudflare/workers-types';
import type { EmailProvider } from '../src/lib/server/email-provider';
import {
	UnsubscribeError,
	UnsubscribeNotFoundError,
	postListUnsubscribe,
	unsubscribeMessage
} from '../src/lib/server/unsubscribe';
import { POST } from '../src/routes/api/mail/[id]/unsubscribe/+server';

const SCHEMA = `
CREATE TABLE domains (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL
);
CREATE TABLE addresses (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	domain_id TEXT NOT NULL,
	address TEXT NOT NULL,
	label TEXT,
	is_default INTEGER NOT NULL DEFAULT 0,
	signature_html TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE emails (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	direction TEXT NOT NULL DEFAULT 'inbound',
	from_addr TEXT NOT NULL DEFAULT 'news@news.test',
	to_addr TEXT NOT NULL,
	subject TEXT NOT NULL DEFAULT 'Weekly',
	body_text TEXT,
	is_read INTEGER NOT NULL DEFAULT 0,
	is_starred INTEGER NOT NULL DEFAULT 1,
	category TEXT NOT NULL DEFAULT 'promotions',
	list_unsubscribe TEXT,
	list_unsubscribe_post TEXT,
	deleted_at TEXT
);
`;

const USER = { id: 'user-1', name: 'Ada' };

function open() {
	const sqlite = new Database(':memory:');
	sqlite.exec(SCHEMA);
	sqlite.run(`INSERT INTO domains (id, name) VALUES ('dom-1', 'cloudmail.test')`);
	sqlite.run(
		`INSERT INTO addresses (id, user_id, domain_id, address, is_default)
		 VALUES ('addr-default', 'user-1', 'dom-1', 'me@cloudmail.test', 1),
		        ('addr-other', 'user-1', 'dom-1', 'other@cloudmail.test', 0)`
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
							const results = sqlite.query(sql).all(...(values as never[]));
							return { results, success: true, meta: {} };
						},
						async run() {
							sqlite.run(sql, values as never[]);
							return { success: true, meta: {} };
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
		id?: string;
		userId?: string;
		to?: string;
		listUnsubscribe?: string | null;
		listUnsubscribePost?: string | null;
	} = {}
) {
	sqlite.run(
		`INSERT INTO emails (id, user_id, to_addr, list_unsubscribe, list_unsubscribe_post)
		 VALUES (?, ?, ?, ?, ?)`,
		[
			row.id ?? 'msg-1',
			row.userId ?? 'user-1',
			row.to ?? 'me@cloudmail.test',
			row.listUnsubscribe === undefined ? '<https://news.test/u>' : row.listUnsubscribe,
			row.listUnsubscribePost === undefined ? 'List-Unsubscribe=One-Click' : row.listUnsubscribePost
		]
	);
}

function snapshot(sqlite: Database, id = 'msg-1') {
	return sqlite.query('SELECT * FROM emails WHERE id = ?').get(id);
}

function emailCount(sqlite: Database) {
	return (sqlite.query('SELECT COUNT(*) AS n FROM emails').get() as { n: number }).n;
}

function provider(send: EmailProvider['send']): EmailProvider {
	return {
		kind: 'resend',
		send,
		async listDomains() {
			return [];
		},
		async getDomain() {
			throw new Error('not used');
		}
	};
}

function redirect(location: string, status = 302): Response {
	return new Response(null, { status, headers: { Location: location } });
}

type FetchCall = { url: string; init: RequestInit };

function scriptedFetch(steps: Array<(url: string) => Response | Promise<Response>>) {
	const calls: FetchCall[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const url = String(input);
		calls.push({ url, init: init ?? {} });
		const step = steps[calls.length - 1];
		if (!step) throw new Error(`unexpected fetch ${url}`);
		return step(url);
	};
	return { calls, fetchImpl };
}

async function withTimeout(run: (seen: number[]) => Promise<void>) {
	const seen: number[] = [];
	const timeout = spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds: number) => {
		seen.push(milliseconds);
		return new AbortController().signal;
	});
	try {
		await run(seen);
	} finally {
		timeout.mockRestore();
	}
}

function expectOneClick(init: RequestInit) {
	const headers = new Headers(init.headers);
	expect(init.method).toBe('POST');
	expect(init.redirect).toBe('manual');
	expect(init.body).toBe('List-Unsubscribe=One-Click');
	expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
	expect(init.signal).toBeInstanceOf(AbortSignal);
}

describe('one-click unsubscribe', () => {
	test('posts the form body and leaves the message row alone', async () => {
		const { sqlite, db } = open();
		addEmail(sqlite);
		const before = snapshot(sqlite);
		const { calls, fetchImpl } = scriptedFetch([() => new Response(null, { status: 204 })]);
		const sent: unknown[] = [];

		await withTimeout(async (timeouts) => {
			await unsubscribeMessage(db, USER, 'msg-1', {
				fetch: fetchImpl,
				provider: provider(async (input) => {
					sent.push(input);
					return { providerId: 'nope' };
				})
			});
			expect(timeouts).toEqual([10_000]);
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe('https://news.test/u');
		expectOneClick(calls[0]!.init);
		expect(sent).toEqual([]);
		expect(snapshot(sqlite)).toEqual(before);
		expect(emailCount(sqlite)).toBe(1);
	});

	test('one-click wins over mailto', async () => {
		const { sqlite, db } = open();
		addEmail(sqlite, {
			listUnsubscribe: '<https://news.test/u>, <mailto:bye@news.test>'
		});
		const { calls, fetchImpl } = scriptedFetch([() => new Response(null, { status: 200 })]);
		const sent: unknown[] = [];

		await withTimeout(async () => {
			await unsubscribeMessage(db, USER, 'msg-1', {
				fetch: fetchImpl,
				provider: provider(async (input) => {
					sent.push(input);
					return { providerId: 'nope' };
				})
			});
		});

		expect(calls).toHaveLength(1);
		expect(sent).toEqual([]);
	});

	test('follows three redirects, resolving Location, then stops', async () => {
		const { calls, fetchImpl } = scriptedFetch([
			() => redirect('next'),
			() => redirect('/abs', 303),
			() => redirect('https://other.test/z', 307),
			() => new Response(null, { status: 200 })
		]);

		await withTimeout(async (timeouts) => {
			await postListUnsubscribe('https://news.test/dir/u', fetchImpl);
			expect(timeouts).toEqual([10_000, 10_000, 10_000, 10_000]);
		});

		expect(calls.map((call) => call.url)).toEqual([
			'https://news.test/dir/u',
			'https://news.test/dir/next',
			'https://news.test/abs',
			'https://other.test/z'
		]);
		for (const call of calls) expectOneClick(call.init);
	});

	test('does not fetch a fourth redirect target', async () => {
		const { calls, fetchImpl } = scriptedFetch([
			() => redirect('https://news.test/a'),
			() => redirect('https://news.test/b'),
			() => redirect('https://news.test/c'),
			() => redirect('https://news.test/d')
		]);

		await withTimeout(async () => {
			await expect(postListUnsubscribe('https://news.test/start', fetchImpl)).rejects.toMatchObject({
				code: 'redirect'
			});
		});

		expect(calls.map((call) => call.url)).toEqual([
			'https://news.test/start',
			'https://news.test/a',
			'https://news.test/b',
			'https://news.test/c'
		]);
	});

	test('refuses a private or non-https redirect and a missing Location', async () => {
		const privateHop = scriptedFetch([() => redirect('https://10.1.2.3/x')]);
		await withTimeout(async () => {
			await expect(postListUnsubscribe('https://news.test/u', privateHop.fetchImpl)).rejects.toMatchObject({
				code: 'private'
			});
		});
		expect(privateHop.calls).toHaveLength(1);

		const httpHop = scriptedFetch([() => redirect('http://news.test/x')]);
		await withTimeout(async () => {
			await expect(postListUnsubscribe('https://news.test/u', httpHop.fetchImpl)).rejects.toMatchObject({
				code: 'https'
			});
		});
		expect(httpHop.calls).toHaveLength(1);

		const missing = scriptedFetch([() => new Response(null, { status: 302 })]);
		await withTimeout(async () => {
			await expect(postListUnsubscribe('https://news.test/u', missing.fetchImpl)).rejects.toMatchObject({
				code: 'redirect'
			});
		});

		const relativePrivate = scriptedFetch([() => redirect('//127.0.0.1/x')]);
		await withTimeout(async () => {
			await expect(postListUnsubscribe('https://news.test/u', relativePrivate.fetchImpl)).rejects.toMatchObject(
				{
					code: 'private'
				}
			);
		});
		expect(relativePrivate.calls).toHaveLength(1);
	});

	test('a refused one-click URL does not fetch or fall through to mailto', async () => {
		const { sqlite, db } = open();
		addEmail(sqlite, {
			listUnsubscribe: '<https://127.0.0.1/u>, <mailto:bye@news.test>',
			listUnsubscribePost: 'ONE-CLICK'
		});
		const before = snapshot(sqlite);
		const { calls, fetchImpl } = scriptedFetch([() => new Response(null, { status: 200 })]);
		const sent: unknown[] = [];

		await expect(
			unsubscribeMessage(db, USER, 'msg-1', {
				fetch: fetchImpl,
				provider: provider(async (input) => {
					sent.push(input);
					return { providerId: 'nope' };
				})
			})
		).rejects.toMatchObject({ code: 'private' });

		expect(calls).toHaveLength(0);
		expect(sent).toEqual([]);
		expect(snapshot(sqlite)).toEqual(before);
	});

	test('a network error or non-success status does not change the message', async () => {
		const { sqlite, db } = open();
		addEmail(sqlite, { listUnsubscribe: '<https://news.test/u>, <mailto:bye@news.test>' });
		const before = snapshot(sqlite);
		const sent: unknown[] = [];
		const mail = provider(async (input) => {
			sent.push(input);
			return { providerId: 'nope' };
		});

		await withTimeout(async () => {
			const failing: typeof fetch = async () => {
				throw new Error('down');
			};
			await expect(
				unsubscribeMessage(db, USER, 'msg-1', { fetch: failing, provider: mail })
			).rejects.toMatchObject({ code: 'network' });

			const { fetchImpl } = scriptedFetch([() => new Response(null, { status: 500 })]);
			await expect(
				unsubscribeMessage(db, USER, 'msg-1', { fetch: fetchImpl, provider: mail })
			).rejects.toMatchObject({ code: 'status' });
		});

		expect(sent).toEqual([]);
		expect(snapshot(sqlite)).toEqual(before);
		expect(emailCount(sqlite)).toBe(1);
	});
});

describe('mailto unsubscribe', () => {
	test('sends one plain message from the owned recipient, otherwise the default', async () => {
		const { sqlite, db } = open();
		addEmail(sqlite, {
			id: 'owned',
			to: 'Ada <other@cloudmail.test>',
			listUnsubscribe: '<mailto:bye@news.test?subject=Go>',
			listUnsubscribePost: null
		});
		addEmail(sqlite, {
			id: 'fallback',
			to: 'stranger@news.test',
			listUnsubscribe: '<https://news.test/u>, <mailto:bye@news.test>',
			listUnsubscribePost: 'List-Unsubscribe=No'
		});
		const beforeOwned = snapshot(sqlite, 'owned');
		const beforeFallback = snapshot(sqlite, 'fallback');
		const sent: Array<{ from: string; to: unknown; subject: string; text: string; senderName: string }> = [];
		const fetchImpl: typeof fetch = async () => {
			throw new Error('mailto must not fetch');
		};
		const mail = provider(async (input) => {
			sent.push({
				from: input.from.address,
				to: input.to,
				subject: input.subject,
				text: input.text,
				senderName: input.senderName
			});
			return { providerId: 'sent-1' };
		});

		await unsubscribeMessage(db, USER, 'owned', { fetch: fetchImpl, provider: mail });
		await unsubscribeMessage(db, USER, 'fallback', { fetch: fetchImpl, provider: mail });

		expect(sent).toEqual([
			{
				from: 'other@cloudmail.test',
				to: ['bye@news.test'],
				subject: 'Go',
				text: 'Unsubscribe',
				senderName: 'Ada'
			},
			{
				from: 'me@cloudmail.test',
				to: ['bye@news.test'],
				subject: 'Unsubscribe',
				text: 'Unsubscribe',
				senderName: 'Ada'
			}
		]);
		expect(snapshot(sqlite, 'owned')).toEqual(beforeOwned);
		expect(snapshot(sqlite, 'fallback')).toEqual(beforeFallback);
		expect(emailCount(sqlite)).toBe(2);
	});

	test('uses the first owned address in To and refuses when none exists', async () => {
		const { sqlite, db } = open();
		addEmail(sqlite, {
			to: 'stranger@news.test, other@cloudmail.test',
			listUnsubscribe: '<mailto:bye@news.test>',
			listUnsubscribePost: null
		});
		const sent: string[] = [];
		await unsubscribeMessage(db, USER, 'msg-1', {
			provider: provider(async (input) => {
				sent.push(input.from.address);
				return { providerId: 'sent-1' };
			})
		});
		expect(sent).toEqual(['other@cloudmail.test']);

		sqlite.run('DELETE FROM addresses');
		addEmail(sqlite, {
			id: 'nowhere',
			to: 'stranger@news.test',
			listUnsubscribe: '<mailto:bye@news.test>',
			listUnsubscribePost: null
		});
		const before = snapshot(sqlite, 'nowhere');
		await expect(unsubscribeMessage(db, USER, 'nowhere', {
			provider: provider(async () => {
				throw new Error('must not send');
			})
		})).rejects.toMatchObject({ code: 'address' });
		expect(snapshot(sqlite, 'nowhere')).toEqual(before);
	});

	test('a failed send returns 400 and does not change the message', async () => {
		const { sqlite, db } = open();
		addEmail(sqlite, {
			listUnsubscribe: '<mailto:bye@news.test>',
			listUnsubscribePost: null
		});
		const before = snapshot(sqlite);
		await expect(
			unsubscribeMessage(db, USER, 'msg-1', {
				provider: provider(async () => {
					throw new Error('smtp down');
				})
			})
		).rejects.toBeInstanceOf(UnsubscribeError);
		await expect(unsubscribeMessage(db, USER, 'msg-1', {})).rejects.toMatchObject({ code: 'send' });
		expect(snapshot(sqlite)).toEqual(before);
		expect(emailCount(sqlite)).toBe(1);
	});

	test('no usable header is a refusal and a missing message is not found', async () => {
		const { sqlite, db } = open();
		addEmail(sqlite, { listUnsubscribe: null, listUnsubscribePost: null });
		const before = snapshot(sqlite);
		await expect(unsubscribeMessage(db, USER, 'msg-1', {})).rejects.toMatchObject({ code: 'header' });
		await expect(unsubscribeMessage(db, USER, 'other-user', {})).rejects.toBeInstanceOf(
			UnsubscribeNotFoundError
		);
		expect(snapshot(sqlite)).toEqual(before);
	});
});

type HandlerEvent = Parameters<typeof POST>[0];

function call(
	init: {
		user?: { id: string; name?: string } | null;
		db?: D1Database | null;
		params?: { id?: string };
	} = {}
) {
	const request = new Request('http://localhost/api/mail/msg-1/unsubscribe', { method: 'POST' });
	return POST({
		request,
		locals: { user: init.user === undefined ? USER : init.user },
		platform: init.db ? { env: { DB: init.db } } : undefined,
		params: init.params ?? { id: 'msg-1' },
		url: new URL(request.url)
	} as HandlerEvent);
}

describe('unsubscribe route', () => {
	test('returns ok, 400, 401, or 404 and does not change the message', async () => {
		const { sqlite, db } = open();
		addEmail(sqlite, {
			listUnsubscribe: '<https://news.test/u>, <mailto:bye@news.test>'
		});
		addEmail(sqlite, {
			id: 'theirs',
			userId: 'user-2',
			listUnsubscribe: '<https://news.test/u>'
		});
		const beforeTheirs = snapshot(sqlite, 'theirs');

		expect((await call({ user: null, db })).status).toBe(401);
		expect((await call({ db: null })).status).toBe(401);
		expect((await call({ db, params: {} })).status).toBe(404);

		const missing = await call({ db, params: { id: 'missing' } });
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({ error: 'Not found' });

		const theirs = await call({ db, params: { id: 'theirs' } });
		expect(theirs.status).toBe(404);
		expect(snapshot(sqlite, 'theirs')).toEqual(beforeTheirs);

		sqlite.run(`UPDATE emails SET list_unsubscribe = '<https://localhost/u>' WHERE id = 'msg-1'`);
		const beforePrivate = snapshot(sqlite);
		const privateLink = await call({ db, params: { id: 'msg-1' } });
		expect(privateLink.status).toBe(400);
		expect(await privateLink.json()).toEqual({ error: 'private' });
		expect(snapshot(sqlite)).toEqual(beforePrivate);

		sqlite.run(
			`UPDATE emails SET list_unsubscribe = '<mailto:bye@news.test>', list_unsubscribe_post = NULL WHERE id = 'msg-1'`
		);
		const beforeMailto = snapshot(sqlite);
		const noProvider = await call({ db, params: { id: 'msg-1' } });
		expect(noProvider.status).toBe(400);
		expect(await noProvider.json()).toEqual({ error: 'send' });
		expect(snapshot(sqlite)).toEqual(beforeMailto);
		expect(emailCount(sqlite)).toBe(2);
	});

	test('posts one-click through the route and leaves the row', async () => {
		const { sqlite, db } = open();
		addEmail(sqlite);
		const before = snapshot(sqlite);
		const calls: FetchCall[] = [];
		const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
			calls.push({ url: String(input), init: init ?? {} });
			return new Response(null, { status: 200 });
		});

		try {
			await withTimeout(async (timeouts) => {
				const response = await call({ db });
				expect(response.status).toBe(200);
				expect(await response.json()).toEqual({ ok: true });
				expect(timeouts).toEqual([10_000]);
			});
		} finally {
			fetchSpy.mockRestore();
		}

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe('https://news.test/u');
		expectOneClick(calls[0]!.init);
		expect(snapshot(sqlite)).toEqual(before);
	});
});

test('unsubscribe tests and implementation do not import the mail store', async () => {
	const banned = ['mail', 'store'].join('-');
	const files = [
		path.join(import.meta.dir, 'unsubscribe-request.test.ts'),
		path.join(import.meta.dir, '../src/lib/server/unsubscribe.ts'),
		path.join(import.meta.dir, '../src/routes/api/mail/[id]/unsubscribe/+server.ts')
	];
	for (const file of files) {
		const source = await Bun.file(file).text();
		expect(source.includes(`from '../src/lib/server/${banned}`)).toBe(false);
		expect(source.includes(`from './${banned}`)).toBe(false);
		expect(source.includes(`from '#lib/server/${banned}`)).toBe(false);
	}
});

test('demo mode rejects unsubscribe', async () => {
	const script = `
		const route = await import('./src/routes/api/mail/[id]/unsubscribe/+server.ts');
		const request = new Request('http://localhost/api/mail/msg-1/unsubscribe', { method: 'POST' });
		const response = await route.POST({
			request,
			locals: { user: { id: 'demo-user-1', name: 'Demo' } },
			platform: { env: { DB: {} } },
			params: { id: 'msg-1' },
			url: new URL(request.url)
		});
		const body = await response.json();
		if (response.status !== 403 || body.error !== 'Demo mode is read-only') {
			throw new Error(response.status + ' ' + JSON.stringify(body));
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
