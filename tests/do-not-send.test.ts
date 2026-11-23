import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { D1Database } from '@cloudflare/workers-types';
import type { EmailProvider, SendEmailInput } from '../src/lib/server/email-provider';
import { deliverDue, insertScheduled, type ScheduledMailInsert } from '../src/lib/server/outbox-schedule';
import {
	ALL_DOMAINS,
	addDoNotSend,
	blockedRecipients,
	handleOneClickUnsubscribe,
	listDoNotSend,
	readSubscription,
	resubscribeByToken,
	unsubscribeToken
} from '../src/lib/server/do-not-send';
import { handleResendWebhook } from '../src/lib/server/inbound';
import type { ResendClient } from '../src/lib/server/resend';

const MIGRATION = await Bun.file(new URL('../migrations/0036_do_not_send.sql', import.meta.url)).text();

const SCHEMA = `
CREATE TABLE users (
	id TEXT PRIMARY KEY,
	email TEXT NOT NULL,
	name TEXT NOT NULL
);
CREATE TABLE emails (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	direction TEXT NOT NULL,
	from_addr TEXT NOT NULL,
	to_addr TEXT NOT NULL,
	cc_addr TEXT,
	bcc_addr TEXT,
	subject TEXT NOT NULL,
	body_text TEXT,
	body_html TEXT,
	in_reply_to TEXT,
	references_header TEXT,
	reply_to_email_id TEXT,
	thread_id TEXT,
	domain_id TEXT,
	provider_id TEXT,
	status TEXT,
	status_at TEXT,
	status_detail TEXT,
	send_at TEXT,
	undo_inbox INTEGER NOT NULL DEFAULT 0,
	source_email_id TEXT,
	draft_action TEXT
);
`;

const ORIGIN = 'https://mail.example.app';

function open() {
	const sqlite = new Database(':memory:');
	sqlite.exec(SCHEMA);
	// The real migration, so the test breaks if the schema and the code drift.
	sqlite.exec(MIGRATION);
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

function row(overrides: Partial<ScheduledMailInsert> = {}): ScheduledMailInsert {
	return {
		userId: 'user-1',
		kind: 'hold',
		sendAt: new Date(Date.now() - 5_000).toISOString(),
		from: 'news@mail.rititech.app',
		to: 'bea@example.com',
		subject: 'November update',
		text: 'Hello Bea',
		html: '<p>Hello Bea</p>',
		...overrides
	};
}

function recordingProvider() {
	const sent: SendEmailInput[] = [];
	const provider: EmailProvider = {
		kind: 'resend',
		async send(input) {
			sent.push(input);
			return { providerId: `prov-${sent.length}` };
		},
		async listDomains() {
			return [];
		},
		async getDomain() {
			throw new Error('unused');
		}
	};
	return { sent, provider };
}

function status(sqlite: Database, id: string) {
	return sqlite.query('SELECT status, status_detail FROM emails WHERE id = ?').get(id) as {
		status: string;
		status_detail: string | null;
	};
}

describe('marketing delivery', () => {
	test('adds one-click List-Unsubscribe headers and a visible footer with the recipient’s own link', async () => {
		const { sqlite, db } = open();
		const { sent, provider } = recordingProvider();
		await insertScheduled(db, row({ marketing: true }));

		expect(await deliverDue(db, provider, new Date(), 20, { origin: ORIGIN })).toBe(1);

		const message = sent[0]!;
		const token = (sqlite.query('SELECT token FROM unsubscribe_links').get() as { token: string }).token;
		expect(message.headers?.['List-Unsubscribe']).toBe(`<${ORIGIN}/api/unsubscribe/${token}>`);
		expect(message.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
		expect(message.text).toContain(`Unsubscribe: ${ORIGIN}/unsubscribe/${token}`);
		expect(message.html).toContain(`href="${ORIGIN}/unsubscribe/${token}"`);
		expect(message.html).toContain('mail.rititech.app mailing list');
	});

	test('ordinary mail carries no unsubscribe header or footer', async () => {
		const { db } = open();
		const { sent, provider } = recordingProvider();
		await insertScheduled(db, row());
		await deliverDue(db, provider, new Date(), 20, { origin: ORIGIN });
		expect(sent[0]!.headers?.['List-Unsubscribe']).toBeUndefined();
		expect(sent[0]!.text).not.toContain('Unsubscribe');
	});

	test('marketing without PUBLIC_ORIGIN fails instead of sending without an unsubscribe link', async () => {
		const { sqlite, db } = open();
		const { sent, provider } = recordingProvider();
		const id = await insertScheduled(db, row({ marketing: true }));
		expect(await deliverDue(db, provider, new Date(), 20, {})).toBe(0);
		expect(sent).toHaveLength(0);
		expect(status(sqlite, id).status).toBe('failed');
		expect(status(sqlite, id).status_detail).toContain('PUBLIC_ORIGIN');
	});

	test('an unsubscribe blocks marketing from that domain but not a one-to-one reply', async () => {
		const { sqlite, db } = open();
		const { sent, provider } = recordingProvider();
		await addDoNotSend(db, { address: 'Bea@Example.com', scope: 'mail.rititech.app', reason: 'unsubscribed' });

		const marketing = await insertScheduled(db, row({ marketing: true }));
		const ordinary = await insertScheduled(db, row());
		const otherDomain = await insertScheduled(db, row({ marketing: true, from: 'hi@shiplog.news' }));
		expect(await deliverDue(db, provider, new Date(), 20, { origin: ORIGIN })).toBe(2);

		expect(status(sqlite, marketing).status).toBe('failed');
		expect(status(sqlite, marketing).status_detail).toContain('bea@example.com unsubscribed');
		expect(status(sqlite, ordinary).status).not.toBe('failed');
		expect(status(sqlite, otherDomain).status).not.toBe('failed');
		expect(sent.map((message) => message.from.address).sort()).toEqual(['hi@shiplog.news', 'news@mail.rititech.app']);
	});

	test('a hard bounce blocks every send to that address, from every domain', async () => {
		const { sqlite, db } = open();
		const { sent, provider } = recordingProvider();
		await addDoNotSend(db, { address: 'bea@example.com', scope: ALL_DOMAINS, reason: 'bounced' });
		const ordinary = await insertScheduled(db, row({ from: 'ada@vibeteck.com', cc: 'cat@example.com' }));
		await deliverDue(db, provider, new Date(), 20, { origin: ORIGIN });
		expect(sent).toHaveLength(0);
		expect(status(sqlite, ordinary).status_detail).toContain('hard-bounced');
	});
});

describe('do-not-send list', () => {
	test('an unsubscribe never downgrades a complaint', async () => {
		const { db } = open();
		await addDoNotSend(db, { address: 'bea@example.com', scope: 'mail.rititech.app', reason: 'complained' });
		await addDoNotSend(db, { address: 'bea@example.com', scope: 'mail.rititech.app', reason: 'unsubscribed' });
		const entries = await listDoNotSend(db);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.reason).toBe('complained');
	});

	test('complaints and unsubscribes only stop marketing; manual and bounced stop everything', async () => {
		const { db } = open();
		await addDoNotSend(db, { address: 'a@x.test', scope: 'mail.rititech.app', reason: 'complained' });
		await addDoNotSend(db, { address: 'b@x.test', scope: 'mail.rititech.app', reason: 'manual' });
		const all = ['a@x.test', 'b@x.test'];
		expect((await blockedRecipients(db, all, 'mail.rititech.app', true)).map((r) => r.address).sort()).toEqual(all);
		expect((await blockedRecipients(db, all, 'mail.rititech.app', false)).map((r) => r.address)).toEqual(['b@x.test']);
		expect(await blockedRecipients(db, all, 'vibeteck.com', true)).toEqual([]);
	});
});

describe('unsubscribe links', () => {
	test('one token per domain and address, reused on later sends', async () => {
		const { db } = open();
		const first = await unsubscribeToken(db, 'mail.rititech.app', 'Bea@example.com');
		expect(await unsubscribeToken(db, 'mail.rititech.app', 'bea@example.com')).toBe(first);
		expect(await unsubscribeToken(db, 'shiplog.news', 'bea@example.com')).not.toBe(first);
		expect(first).toMatch(/^[A-Za-z0-9_-]{32}$/);
	});

	test('one-click POST unsubscribes with no Origin header; GET only redirects to the page', async () => {
		const { db } = open();
		const token = await unsubscribeToken(db, 'mail.rititech.app', 'bea@example.com');
		const url = `${ORIGIN}/api/unsubscribe/${token}`;

		const get = await handleOneClickUnsubscribe(new Request(url), db);
		expect(get?.status).toBe(303);
		expect(get?.headers.get('Location')).toBe(`/unsubscribe/${token}`);
		expect((await readSubscription(db, token))?.subscribed).toBe(true);

		const post = await handleOneClickUnsubscribe(
			new Request(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: 'List-Unsubscribe=One-Click'
			}),
			db
		);
		expect(post?.status).toBe(200);
		expect((await readSubscription(db, token))?.subscribed).toBe(false);

		// Pressing it twice is fine.
		expect((await handleOneClickUnsubscribe(new Request(url, { method: 'POST' }), db))?.status).toBe(200);
	});

	test('unknown tokens and other paths', async () => {
		const { db } = open();
		const missing = await handleOneClickUnsubscribe(
			new Request(`${ORIGIN}/api/unsubscribe/AAAAAAAAAAAAAAAAAAAAAAAA`, { method: 'POST' }),
			db
		);
		expect(missing?.status).toBe(404);
		expect(await handleOneClickUnsubscribe(new Request(`${ORIGIN}/api/mail`), db)).toBeNull();
		expect(await readSubscription(db, '../../etc')).toBeNull();
	});

	test('subscribing again clears the unsubscribe and complaint, never a hard bounce', async () => {
		const { db } = open();
		const token = await unsubscribeToken(db, 'mail.rititech.app', 'bea@example.com');
		await addDoNotSend(db, { address: 'bea@example.com', scope: 'mail.rititech.app', reason: 'complained' });
		expect((await resubscribeByToken(db, token))?.subscribed).toBe(true);

		await addDoNotSend(db, { address: 'bea@example.com', scope: ALL_DOMAINS, reason: 'bounced' });
		expect((await resubscribeByToken(db, token))?.subscribed).toBe(false);
	});
});

describe('Resend webhook feeds the list', () => {
	const client = {} as ResendClient;
	const env = (db: D1Database) => ({ DB: db, ATTACHMENTS: {} as never });

	test('a permanent bounce blocks the address on every domain', async () => {
		const { db } = open();
		await handleResendWebhook(
			{
				type: 'email.bounced',
				data: {
					email_id: 'prov-1',
					from: 'news@mail.rititech.app',
					to: ['gone@example.com'],
					bounce: { type: 'Permanent', subType: 'General', message: 'Mailbox does not exist' }
				}
			},
			env(db),
			client
		);
		const entries = await listDoNotSend(db);
		expect(entries.map(({ address, scope, reason }) => ({ address, scope, reason }))).toEqual([
			{ address: 'gone@example.com', scope: '*', reason: 'bounced' }
		]);
	});

	test('a soft bounce is left alone', async () => {
		const { db } = open();
		await handleResendWebhook(
			{
				type: 'email.bounced',
				data: { email_id: 'prov-1', to: ['full@example.com'], bounce: { type: 'Transient', subType: 'MailboxFull' } }
			},
			env(db),
			client
		);
		expect(await listDoNotSend(db)).toEqual([]);
	});

	test('a spam complaint blocks marketing from the sending domain', async () => {
		const { db } = open();
		await handleResendWebhook(
			{
				type: 'email.complained',
				data: { email_id: 'prov-1', from: 'Rititech <news@mail.rititech.app>', to: ['angry@example.com'] }
			},
			env(db),
			client
		);
		const entries = await listDoNotSend(db);
		expect(entries.map(({ address, scope, reason }) => ({ address, scope, reason }))).toEqual([
			{ address: 'angry@example.com', scope: 'mail.rititech.app', reason: 'complained' }
		]);
	});
});
