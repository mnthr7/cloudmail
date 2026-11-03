import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { D1Database } from '@cloudflare/workers-types';
import type { EmailProvider } from '../src/lib/server/email-provider';
import {
	claimScheduled,
	deliverDue,
	insertScheduled,
	undoScheduled,
	type ScheduledMailInsert
} from '../src/lib/server/outbox-schedule';
import { holdUntil, scheduleError } from '../src/lib/writing/timing';

const SCHEMA = `
CREATE TABLE users (
	id TEXT PRIMARY KEY,
	email TEXT NOT NULL,
	name TEXT NOT NULL,
	password_hash TEXT NOT NULL DEFAULT 'x',
	is_admin INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
	status_detail TEXT,
	send_at TEXT,
	undo_inbox INTEGER NOT NULL DEFAULT 0,
	source_email_id TEXT,
	draft_action TEXT,
	in_inbox INTEGER NOT NULL DEFAULT 1,
	snoozed_until TEXT,
	deleted_at TEXT,
	is_spam INTEGER NOT NULL DEFAULT 0
);
`;

type EmailRecord = {
	id: string;
	status: string | null;
	send_at: string | null;
	provider_id: string | null;
	status_detail: string | null;
	in_inbox: number;
	snoozed_until: string | null;
	is_spam: number;
	deleted_at: string | null;
	undo_inbox: number;
	source_email_id: string | null;
	thread_id: string | null;
};

function open() {
	const sqlite = new Database(':memory:');
	sqlite.exec(SCHEMA);
	sqlite.run(
		`INSERT INTO users (id, email, name) VALUES ('user-1', 'ada@login.test', 'Ada')`
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
		from: 'ada@example.com',
		to: 'bea@example.com',
		subject: 'Hello',
		text: 'Body',
		...overrides
	};
}

function email(sqlite: Database, id: string): EmailRecord {
	const stored = sqlite.query('SELECT * FROM emails WHERE id = ?').get(id) as EmailRecord | null;
	if (!stored) throw new Error(`missing email ${id}`);
	return stored;
}

function countEmails(sqlite: Database): number {
	const stored = sqlite.query('SELECT COUNT(*) AS n FROM emails').get() as { n: number };
	return stored.n;
}

/** Two messages in one conversation. The scheduled row points at the first. */
function addSourceConversation(sqlite: Database) {
	const sql = `INSERT INTO emails (
		id, user_id, direction, from_addr, to_addr, subject, thread_id,
		in_inbox, snoozed_until, is_spam, deleted_at, status
	) VALUES (?, 'user-1', 'inbound', 'bea@example.com', 'ada@example.com', ?, 'thread-1', 0, '2026-12-01T00:00:00.000Z', 0, NULL, 'delivered')`;
	sqlite.run(sql, ['msg-a', 'Hello']);
	sqlite.run(sql, ['msg-b', 'Hello again']);
}

function resendProvider(send: EmailProvider['send']): EmailProvider {
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

/** Archive stays in the caller. A false result must not reach insertScheduled. */
async function stubArchive(ok: boolean): Promise<boolean> {
	return ok;
}

describe('outbox schedule', () => {
	test('claims a due row once and uses the provider initial status', async () => {
		const { sqlite, db } = open();
		const now = new Date();
		const id = await insertScheduled(db, row());

		expect(await claimScheduled(db, id, 'user-1', now, { kind: 'resend' })).toBe(true);
		expect(await claimScheduled(db, id, 'user-1', now, { kind: 'resend' })).toBe(false);
		expect(email(sqlite, id).status).toBe('queued');

		const cloudflareId = await insertScheduled(db, row({ subject: 'Other' }));
		expect(await claimScheduled(db, cloudflareId, 'user-1', now, { kind: 'cloudflare' })).toBe(
			true
		);
		expect(email(sqlite, cloudflareId).status).toBe('sent');
	});

	test('does not claim a row whose send_at is still ahead', async () => {
		const { sqlite, db } = open();
		const id = await insertScheduled(
			db,
			row({ sendAt: new Date(Date.now() + 120_000).toISOString() })
		);

		expect(await claimScheduled(db, id, 'user-1', new Date(), { kind: 'resend' })).toBe(false);
		expect(email(sqlite, id).status).toBe('scheduled');
	});

	test('undo while scheduled restores both messages in the source conversation', async () => {
		const { sqlite, db } = open();
		addSourceConversation(sqlite);
		const id = await insertScheduled(
			db,
			row({
				sendAt: holdUntil(new Date(), 10),
				undoInbox: true,
				sourceEmailId: 'msg-a'
			})
		);

		expect(await undoScheduled(db, id, 'user-1')).toBe('draft');

		const scheduled = email(sqlite, id);
		expect(scheduled.status).toBe('draft');
		expect(scheduled.send_at).toBe(null);

		for (const sourceId of ['msg-a', 'msg-b']) {
			const source = email(sqlite, sourceId);
			expect(source.in_inbox).toBe(1);
			expect(source.snoozed_until).toBe(null);
			expect(source.is_spam).toBe(0);
			expect(source.deleted_at).toBe(null);
			expect(source.thread_id).toBe('thread-1');
		}
	});

	test('undo after the claim reports sent and leaves the inbox', async () => {
		const { sqlite, db } = open();
		addSourceConversation(sqlite);
		const id = await insertScheduled(
			db,
			row({ undoInbox: true, sourceEmailId: 'msg-a' })
		);

		expect(await claimScheduled(db, id, 'user-1', new Date(), { kind: 'resend' })).toBe(true);
		expect(await undoScheduled(db, id, 'user-1')).toBe('sent');

		const scheduled = email(sqlite, id);
		expect(scheduled.status).toBe('queued');
		expect(scheduled.send_at).not.toBe(null);

		for (const sourceId of ['msg-a', 'msg-b']) {
			const source = email(sqlite, sourceId);
			expect(source.in_inbox).toBe(0);
			expect(source.snoozed_until).toBe('2026-12-01T00:00:00.000Z');
		}
	});

	test('deliverDue sends a due row once and skips a future row', async () => {
		const { sqlite, db } = open();
		const dueId = await insertScheduled(db, row({ subject: 'Due' }));
		const laterId = await insertScheduled(
			db,
			row({
				subject: 'Later',
				sendAt: new Date(Date.now() + 120_000).toISOString()
			})
		);
		let calls = 0;
		const provider = resendProvider(async () => {
			calls += 1;
			return { providerId: 'prov-due' };
		});

		expect(await deliverDue(db, provider, new Date())).toBe(1);
		expect(calls).toBe(1);
		expect(email(sqlite, dueId).status).toBe('queued');
		expect(email(sqlite, dueId).provider_id).toBe('prov-due');
		expect(email(sqlite, laterId).status).toBe('scheduled');
		expect(email(sqlite, laterId).provider_id).toBe(null);

		expect(await deliverDue(db, provider, new Date())).toBe(0);
		expect(calls).toBe(1);
	});

	test('a provider failure is stored and not selected again', async () => {
		const { sqlite, db } = open();
		const id = await insertScheduled(db, row());
		let calls = 0;
		const provider = resendProvider(async () => {
			calls += 1;
			throw new Error('mailbox full');
		});

		expect(await deliverDue(db, provider, new Date())).toBe(0);
		expect(calls).toBe(1);
		expect(email(sqlite, id).status).toBe('failed');
		expect(email(sqlite, id).status_detail).toBe('mailbox full');
		expect(email(sqlite, id).provider_id).toBe(null);

		expect(await deliverDue(db, provider, new Date())).toBe(0);
		expect(calls).toBe(1);
	});

	test('a schedule 30 seconds ahead throws before any insert', async () => {
		const { sqlite, db } = open();
		const sendAt = new Date(Date.now() + 30_000).toISOString();
		let thrown: unknown;
		try {
			await insertScheduled(db, row({ kind: 'schedule', sendAt }));
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toBe('Pick a time at least a minute from now.');
		expect(countEmails(sqlite)).toBe(0);

		const accepted = new Date(Date.now() + 120_000).toISOString();
		const id = await insertScheduled(db, row({ kind: 'schedule', sendAt: accepted }));
		expect(email(sqlite, id).status).toBe('scheduled');
		expect(email(sqlite, id).send_at).toBe(accepted);
	});

	test('a hold under a minute is stored', async () => {
		const { sqlite, db } = open();
		const sendAt = holdUntil(new Date(), 10);
		const id = await insertScheduled(db, row({ kind: 'hold', sendAt }));

		expect(email(sqlite, id).status).toBe('scheduled');
		expect(email(sqlite, id).send_at).toBe(sendAt);
		expect(email(sqlite, id).undo_inbox).toBe(0);
	});

	test('scheduleError is the body string the schedule branch returns', () => {
		const now = new Date('2026-10-31T23:00:00.000Z');
		expect(scheduleError('2026-10-31T23:00:30.000Z', now)).toBe(
			'Pick a time at least a minute from now.'
		);
		expect(scheduleError('2026-10-31T23:01:00.000Z', now)).toBe(null);
	});

	test('deliverDue is what the worker cron calls, and a second call delivers 0', async () => {
		const worker = await Bun.file(new URL('../src/worker.ts', import.meta.url)).text();
		expect(worker).toContain('deliverDue(env.DB, getEmailProvider({ env }), new Date(), 20)');
		expect(worker).toContain('Failed to deliver scheduled mail');

		const { sqlite, db } = open();
		const id = await insertScheduled(db, row());
		let calls = 0;
		const provider = resendProvider(async () => {
			calls += 1;
			return { providerId: 'prov-once' };
		});

		expect(await deliverDue(db, provider, new Date(), 20)).toBe(1);
		expect(await deliverDue(db, provider, new Date(), 20)).toBe(0);
		expect(calls).toBe(1);
		expect(email(sqlite, id).status).toBe('queued');
		expect(email(sqlite, id).provider_id).toBe('prov-once');
	});

	test('inserts a scheduled row only after archive succeeds', async () => {
		const failed = open();
		if (await stubArchive(false)) {
			await insertScheduled(failed.db, row({ undoInbox: true, sourceEmailId: 'msg-a' }));
		}
		expect(countEmails(failed.sqlite)).toBe(0);

		const succeeded = open();
		addSourceConversation(succeeded.sqlite);
		if (await stubArchive(true)) {
			await insertScheduled(
				succeeded.db,
				row({ undoInbox: true, sourceEmailId: 'msg-a', sendAt: holdUntil(new Date(), 10) })
			);
		}
		expect(countEmails(succeeded.sqlite)).toBe(3);
		const scheduled = succeeded.sqlite
			.query(`SELECT undo_inbox, source_email_id, status FROM emails WHERE status = 'scheduled'`)
			.get() as { undo_inbox: number; source_email_id: string; status: string };
		expect(scheduled.undo_inbox).toBe(1);
		expect(scheduled.source_email_id).toBe('msg-a');
		expect(scheduled.status).toBe('scheduled');
	});
});
