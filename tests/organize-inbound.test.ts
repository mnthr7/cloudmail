import { Database } from 'bun:sqlite';
import { describe, expect, spyOn, test } from 'bun:test';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { handleCloudflareInbound } from '../src/lib/server/cloudflare-inbound';
import type { EmailProvider } from '../src/lib/server/email-provider';
import { handleResendWebhook } from '../src/lib/server/inbound';
import { sendAndStore } from '../src/lib/server/outbox';
import type { User } from '../src/lib/types';
import {
	applyFilterActions,
	organizeInbound,
	readInboundHeader,
	type OrganizeInboundHeaders
} from '../src/lib/server/organize-inbound';
import type { ResendClient } from '../src/lib/server/resend';

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
	from_name TEXT,
	to_addr TEXT NOT NULL,
	cc_addr TEXT,
	bcc_addr TEXT,
	subject TEXT NOT NULL,
	body_text TEXT,
	body_html TEXT,
	message_id TEXT,
	in_reply_to TEXT,
	references_header TEXT,
	reply_to_header TEXT,
	reply_to_email_id TEXT,
	thread_id TEXT,
	thread_key TEXT,
	domain_id TEXT,
	provider_id TEXT,
	status TEXT,
	status_at TEXT,
	status_detail TEXT,
	is_read INTEGER NOT NULL DEFAULT 0,
	is_starred INTEGER NOT NULL DEFAULT 0,
	is_spam INTEGER NOT NULL DEFAULT 0,
	in_inbox INTEGER NOT NULL DEFAULT 1,
	category TEXT NOT NULL DEFAULT 'primary',
	is_important INTEGER NOT NULL DEFAULT 0,
	snoozed_until TEXT,
	is_muted INTEGER NOT NULL DEFAULT 0,
	list_unsubscribe TEXT,
	list_unsubscribe_post TEXT,
	deleted_at TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE email_attachments (
	id TEXT PRIMARY KEY,
	email_id TEXT NOT NULL,
	filename TEXT NOT NULL,
	content_type TEXT NOT NULL,
	size_bytes INTEGER NOT NULL,
	content_base64 TEXT,
	storage_key TEXT,
	scan_status TEXT NOT NULL DEFAULT 'skipped'
);
CREATE TABLE labels (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
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
CREATE TABLE sender_categories (
	user_id TEXT NOT NULL,
	from_addr TEXT NOT NULL,
	category TEXT NOT NULL,
	PRIMARY KEY (user_id, from_addr)
);
CREATE TABLE filters (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	position INTEGER NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1,
	match_from TEXT,
	match_to TEXT,
	match_subject TEXT,
	match_words TEXT,
	match_has_attachment INTEGER NOT NULL DEFAULT 0,
	action_label_id TEXT,
	action_skip_inbox INTEGER NOT NULL DEFAULT 0,
	action_star INTEGER NOT NULL DEFAULT 0,
	action_important INTEGER NOT NULL DEFAULT 0,
	action_mark_read INTEGER NOT NULL DEFAULT 0,
	action_trash INTEGER NOT NULL DEFAULT 0,
	action_category TEXT,
	action_forward_to TEXT
);
CREATE TABLE blocked_senders (
	user_id TEXT NOT NULL,
	address TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	PRIMARY KEY (user_id, address)
);
`;

type Stored = {
	category: string;
	is_important: number;
	is_muted: number;
	snoozed_until: string | null;
	in_inbox: number;
	is_spam: number;
	is_starred: number;
	is_read: number;
	deleted_at: string | null;
	list_unsubscribe: string | null;
	list_unsubscribe_post: string | null;
	direction: string;
};

function open() {
	const sqlite = new Database(':memory:');
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
		direction?: string;
		from?: string;
		to?: string;
		subject?: string;
		body?: string;
		threadId?: string;
		inInbox?: number;
		category?: string;
		important?: number;
		muted?: number;
		snoozed?: string | null;
		createdAt?: string;
		userId?: string;
	}
) {
	sqlite.run(
		`INSERT INTO emails (
			id, user_id, direction, from_addr, to_addr, subject, body_text, thread_id,
			in_inbox, category, is_important, is_muted, snoozed_until, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			row.id,
			row.userId ?? 'user-1',
			row.direction ?? 'inbound',
			row.from ?? 'ada@example.com',
			row.to ?? 'me@cloudmail.test',
			row.subject ?? 'Hello',
			row.body ?? 'plain body',
			row.threadId ?? 'thread-1',
			row.inInbox ?? 1,
			row.category ?? 'primary',
			row.important ?? 0,
			row.muted ?? 0,
			row.snoozed ?? null,
			row.createdAt ?? '2026-01-02 00:00:00'
		]
	);
}

function addFilter(
	sqlite: Database,
	row: {
		id: string;
		position: number;
		enabled?: number;
		matchFrom?: string | null;
		matchSubject?: string | null;
		matchWords?: string | null;
		matchAttachment?: number;
		labelId?: string | null;
		skipInbox?: number;
		star?: number;
		important?: number;
		markRead?: number;
		trash?: number;
		category?: string | null;
		forwardTo?: string | null;
		userId?: string;
	}
) {
	sqlite.run(
		`INSERT INTO filters (
			id, user_id, position, enabled, match_from, match_subject, match_words, match_has_attachment,
			action_label_id, action_skip_inbox, action_star, action_important, action_mark_read,
			action_trash, action_category, action_forward_to
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			row.id,
			row.userId ?? 'user-1',
			row.position,
			row.enabled ?? 1,
			row.matchFrom ?? null,
			row.matchSubject ?? null,
			row.matchWords ?? null,
			row.matchAttachment ?? 0,
			row.labelId ?? null,
			row.skipInbox ?? 0,
			row.star ?? 0,
			row.important ?? 0,
			row.markRead ?? 0,
			row.trash ?? 0,
			row.category ?? null,
			row.forwardTo ?? null
		]
	);
}

function seedSendingIdentity(sqlite: Database) {
	sqlite.run(
		`INSERT INTO domains (id, name) VALUES ('dom-1', 'cloudmail.test')`
	);
	sqlite.run(
		`INSERT INTO addresses (id, user_id, domain_id, address, is_default)
		 VALUES ('addr-1', 'user-1', 'dom-1', 'me@cloudmail.test', 1)`
	);
}

function stored(sqlite: Database, id: string): Stored {
	const row = sqlite
		.query(
			`SELECT direction, category, is_important, is_muted, snoozed_until, in_inbox, is_spam,
			        is_starred, is_read, deleted_at, list_unsubscribe, list_unsubscribe_post
			 FROM emails WHERE id = ?`
		)
		.get(id) as Stored | null;
	if (!row) throw new Error(`missing email ${id}`);
	return row;
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

const quietHeaders: OrganizeInboundHeaders = { hasAttachment: false };

describe('readInboundHeader', () => {
	test('reads either casing and treats a blank value as absent', () => {
		expect(readInboundHeader({ 'List-Unsubscribe': ' <https://ex.test/u> ' }, 'list-unsubscribe')).toBe(
			'<https://ex.test/u>'
		);
		expect(readInboundHeader(new Headers({ 'Auto-Submitted': 'auto-generated' }), 'auto-submitted')).toBe(
			'auto-generated'
		);
		expect(readInboundHeader({ Precedence: '   ' }, 'precedence')).toBeNull();
		expect(readInboundHeader(undefined, 'list-id')).toBeNull();
	});
});

describe('organizeInbound', () => {
	test('wakes an archived snoozed thread, then a skip-inbox filter archives it again', async () => {
		const { sqlite, db } = open();
		addEmail(sqlite, {
			id: 'old',
			inInbox: 0,
			snoozed: '2099-01-01T00:00:00.000Z',
			important: 1,
			createdAt: '2026-01-01 00:00:00'
		});
		addEmail(sqlite, { id: 'new', inInbox: 0, createdAt: '2026-01-02 00:00:00' });
		addFilter(sqlite, { id: 'skip', position: 1, matchFrom: 'ada@', skipInbox: 1 });

		await organizeInbound(db, 'user-1', 'new', {
			...quietHeaders,
			listUnsubscribe: '<https://ex.test/u>'
		});

		for (const id of ['old', 'new']) {
			const row = stored(sqlite, id);
			expect(row.in_inbox).toBe(0);
			expect(row.snoozed_until).toBeNull();
			expect(row.is_important).toBe(1);
			expect(row.category).toBe('promotions');
			expect(row.is_spam).toBe(0);
		}
	});

	test('a muted thread stays archived and snoozed, and filters still apply', async () => {
		const { sqlite, db } = open();
		addEmail(sqlite, {
			id: 'old',
			inInbox: 0,
			muted: 1,
			snoozed: '2099-06-01T00:00:00.000Z',
			createdAt: '2026-01-01 00:00:00'
		});
		addEmail(sqlite, { id: 'new', createdAt: '2026-01-02 00:00:00' });
		addFilter(sqlite, { id: 'star', position: 1, matchFrom: 'ada@', star: 1 });

		await organizeInbound(db, 'user-1', 'new', quietHeaders);

		for (const id of ['old', 'new']) {
			const row = stored(sqlite, id);
			expect(row.is_muted).toBe(1);
			expect(row.in_inbox).toBe(0);
			expect(row.snoozed_until).toBe('2099-06-01T00:00:00.000Z');
			expect(row.is_starred).toBe(1);
		}
	});

	test('a blocked sender marks the thread spam, skips filters, and does not insert another block', async () => {
		const { sqlite, db } = open();
		addEmail(sqlite, {
			id: 'old',
			from: 'spam@evil.test',
			category: 'forums',
			important: 1,
			snoozed: '2099-01-01T00:00:00.000Z',
			createdAt: '2026-01-01 00:00:00'
		});
		addEmail(sqlite, {
			id: 'new',
			from: 'Spam <spam@evil.test>',
			createdAt: '2026-01-02 00:00:00'
		});
		sqlite.run(`INSERT INTO blocked_senders (user_id, address) VALUES ('user-1', 'spam@evil.test')`);
		sqlite.run(`INSERT INTO blocked_senders (user_id, address) VALUES ('user-2', 'ada@example.com')`);
		addFilter(sqlite, { id: 'star', position: 1, matchFrom: 'spam@', star: 1, category: 'social' });

		await organizeInbound(db, 'user-1', 'new', {
			...quietHeaders,
			listUnsubscribe: '<https://ex.test/u>'
		});

		for (const id of ['old', 'new']) {
			const row = stored(sqlite, id);
			expect(row.is_spam).toBe(1);
			expect(row.snoozed_until).toBeNull();
			expect(row.category).toBe('forums');
			expect(row.is_important).toBe(1);
			expect(row.is_starred).toBe(0);
		}
		const blocks = sqlite
			.query(`SELECT COUNT(*) AS n FROM blocked_senders WHERE user_id = 'user-1'`)
			.get() as { n: number };
		expect(blocks.n).toBe(1);
	});

	test('sender category beats the built-in rules and is written on the thread', async () => {
		const { sqlite, db } = open();
		addEmail(sqlite, { id: 'old', category: 'primary', createdAt: '2026-01-01 00:00:00' });
		addEmail(sqlite, { id: 'new', createdAt: '2026-01-02 00:00:00' });
		sqlite.run(
			`INSERT INTO sender_categories (user_id, from_addr, category) VALUES ('user-1', 'ada@example.com', 'social')`
		);

		await organizeInbound(db, 'user-1', 'new', {
			...quietHeaders,
			listUnsubscribe: '<https://ex.test/u>'
		});

		expect(stored(sqlite, 'old').category).toBe('social');
		expect(stored(sqlite, 'new').category).toBe('social');
		expect(stored(sqlite, 'new').in_inbox).toBe(1);
	});

	test('without a sender category, list headers assign forums', async () => {
		const { sqlite, db } = open();
		addEmail(sqlite, { id: 'new', threadId: 'new' });

		await organizeInbound(db, 'user-1', 'new', {
			hasAttachment: false,
			listId: '<list.example.com>',
			references: '<parent@example.com>'
		});

		expect(stored(sqlite, 'new').category).toBe('forums');
	});

	test('enabled filters run in position order, and a later category wins', async () => {
		const { sqlite, db } = open();
		addEmail(sqlite, { id: 'old', inInbox: 1, createdAt: '2026-01-01 00:00:00' });
		addEmail(sqlite, { id: 'new', subject: 'Invoice', body: 'pay the balance', createdAt: '2026-01-02 00:00:00' });
		sqlite.run(
			`INSERT INTO labels (id, user_id, name) VALUES ('label-bills', 'user-1', 'Bills')`
		);
		addFilter(sqlite, {
			id: 'disabled',
			position: 0,
			enabled: 0,
			matchFrom: 'ada@',
			category: 'forums'
		});
		addFilter(sqlite, {
			id: 'first',
			position: 1,
			matchFrom: 'ada@',
			star: 1,
			category: 'promotions',
			labelId: 'label-bills'
		});
		addFilter(sqlite, {
			id: 'second',
			position: 2,
			matchSubject: 'invoice',
			important: 1,
			markRead: 1,
			trash: 1,
			category: 'updates'
		});
		addFilter(sqlite, {
			id: 'attachment-only',
			position: 3,
			matchAttachment: 1,
			category: 'social'
		});

		await organizeInbound(db, 'user-1', 'new', quietHeaders);

		for (const id of ['old', 'new']) {
			const row = stored(sqlite, id);
			expect(row.category).toBe('updates');
			expect(row.is_starred).toBe(1);
			expect(row.is_important).toBe(1);
			expect(row.is_read).toBe(1);
			expect(row.deleted_at).not.toBeNull();
		}
		const label = sqlite
			.query(`SELECT label_id FROM thread_labels WHERE user_id = 'user-1' AND thread_id = 'thread-1'`)
			.get() as { label_id: string };
		expect(label.label_id).toBe('label-bills');
	});

	test('an attachment filter matches only when the attachment list is non-empty', async () => {
		const { sqlite, db } = open();
		addEmail(sqlite, { id: 'plain', threadId: 'plain' });
		addEmail(sqlite, { id: 'file', threadId: 'file' });
		addFilter(sqlite, { id: 'files', position: 1, matchAttachment: 1, star: 1 });

		await organizeInbound(db, 'user-1', 'plain', quietHeaders);
		await organizeInbound(db, 'user-1', 'file', { hasAttachment: true });

		expect(stored(sqlite, 'plain').is_starred).toBe(0);
		expect(stored(sqlite, 'file').is_starred).toBe(1);
	});

	test('outbound mail copies the newest sibling and does not wake, filter, or forward', async () => {
		const { sqlite, db } = open();
		seedSendingIdentity(sqlite);
		addEmail(sqlite, {
			id: 'older',
			inInbox: 0,
			category: 'primary',
			createdAt: '2026-01-01 00:00:00'
		});
		addEmail(sqlite, {
			id: 'newer',
			inInbox: 0,
			category: 'forums',
			important: 1,
			muted: 1,
			snoozed: '2099-03-01T00:00:00.000Z',
			createdAt: '2026-01-03 00:00:00'
		});
		addEmail(sqlite, {
			id: 'sent',
			direction: 'outbound',
			from: 'me@cloudmail.test',
			createdAt: '2026-01-04 00:00:00'
		});
		addFilter(sqlite, {
			id: 'fwd',
			position: 1,
			matchFrom: 'me@',
			star: 1,
			forwardTo: 'boss@elsewhere.test'
		});
		const sent: unknown[] = [];

		await organizeInbound(
			db,
			'user-1',
			'sent',
			quietHeaders,
			provider(async (input) => {
				sent.push(input);
				return { providerId: 'should-not-send' };
			})
		);

		const row = stored(sqlite, 'sent');
		expect(row.category).toBe('forums');
		expect(row.is_important).toBe(1);
		expect(row.is_muted).toBe(1);
		expect(row.snoozed_until).toBe('2099-03-01T00:00:00.000Z');
		expect(row.in_inbox).toBe(stored(sqlite, 'newer').in_inbox);
		expect(stored(sqlite, 'newer').in_inbox).toBe(0);
		expect(stored(sqlite, 'newer').snoozed_until).toBe('2099-03-01T00:00:00.000Z');
		expect(row.is_starred).toBe(0);
		expect(sent).toHaveLength(0);
	});

	test('a sent reply keeps mute and snooze so the next inbound stays out of the inbox', async () => {
		const { sqlite, db } = open();
		seedSendingIdentity(sqlite);
		const snooze = '2099-06-01T00:00:00.000Z';
		addEmail(sqlite, {
			id: 'old',
			from: 'ada@example.com',
			to: 'me@cloudmail.test',
			subject: 'Hello',
			inInbox: 0,
			muted: 1,
			snoozed: snooze,
			createdAt: '2026-01-01 00:00:00'
		});
		const user: User = {
			id: 'user-1',
			email: 'ada@login.test',
			name: 'Ada',
			is_admin: false,
			created_at: '2026-01-01 00:00:00'
		};

		const { emailId } = await sendAndStore(
			{ DB: db, ATTACHMENTS: {} as R2Bucket },
			provider(async () => ({ providerId: 'prov-reply' })),
			user,
			{
				to: 'ada@example.com',
				subject: 'Re: Hello',
				text: 'On it',
				replyToEmailId: 'old'
			}
		);

		const sentRow = stored(sqlite, emailId);
		expect(sentRow.direction).toBe('outbound');
		expect(sentRow.is_muted).toBe(1);
		expect(sentRow.snoozed_until).toBe(snooze);
		expect(stored(sqlite, 'old').is_muted).toBe(1);
		expect(stored(sqlite, 'old').in_inbox).toBe(0);
		expect(stored(sqlite, 'old').snoozed_until).toBe(snooze);

		addEmail(sqlite, {
			id: 'next',
			from: 'ada@example.com',
			to: 'me@cloudmail.test',
			subject: 'Re: Hello',
			createdAt: '2099-01-01 00:00:00'
		});
		await organizeInbound(db, 'user-1', 'next', quietHeaders);

		for (const id of ['old', emailId, 'next']) {
			const row = stored(sqlite, id);
			expect(row.is_muted).toBe(1);
			expect(row.in_inbox).toBe(0);
			expect(row.snoozed_until).toBe(snooze);
		}
	});

	test('forwards after filing, and one failed send does not throw or skip the next', async () => {
		const { sqlite, db } = open();
		seedSendingIdentity(sqlite);
		addEmail(sqlite, { id: 'new', threadId: 'new', subject: 'Hello', body: 'plain body' });
		addFilter(sqlite, {
			id: 'one',
			position: 1,
			matchFrom: 'ada@',
			star: 1,
			forwardTo: 'first@elsewhere.test'
		});
		addFilter(sqlite, {
			id: 'two',
			position: 2,
			matchFrom: 'ada@',
			forwardTo: 'second@elsewhere.test'
		});
		const sent: Array<{ to: unknown; subject: string; text: string; from: string; senderName: string }> = [];
		const errors = spyOn(console, 'error').mockImplementation(() => {});

		try {
			await organizeInbound(
				db,
				'user-1',
				'new',
				quietHeaders,
				provider(async (input) => {
					const to = Array.isArray(input.to) ? input.to[0] : input.to;
					if (to === 'first@elsewhere.test') throw new Error('smtp down');
					sent.push({
						to: input.to,
						subject: input.subject,
						text: input.text,
						from: input.from.address,
						senderName: input.senderName
					});
					return { providerId: 'sent-2' };
				})
			);

			expect(stored(sqlite, 'new').is_starred).toBe(1);
			expect(sent).toEqual([
				{
					to: ['second@elsewhere.test'],
					subject: 'Fwd: Hello',
					text: 'plain body',
					from: 'me@cloudmail.test',
					senderName: 'Ada'
				}
			]);
			expect(errors.mock.calls.some((call) => call[0] === 'Failed to forward inbound mail')).toBe(
				true
			);
		} finally {
			errors.mockRestore();
		}
	});

	test('a missing provider or sending address is logged and does not throw', async () => {
		const { sqlite, db } = open();
		addEmail(sqlite, { id: 'new', threadId: 'new' });
		addFilter(sqlite, { id: 'fwd', position: 1, matchFrom: 'ada@', forwardTo: 'boss@elsewhere.test' });
		const errors = spyOn(console, 'error').mockImplementation(() => {});

		try {
			await organizeInbound(db, 'user-1', 'new', quietHeaders);
			expect(errors.mock.calls.some((call) => String(call[2]).includes('No sending provider'))).toBe(
				true
			);

			errors.mockClear();
			await organizeInbound(
				db,
				'user-1',
				'new',
				quietHeaders,
				provider(async () => {
					throw new Error('should not send');
				})
			);
			expect(errors.mock.calls.some((call) => String(call[2]).includes('No sending address'))).toBe(
				true
			);
		} finally {
			errors.mockRestore();
		}
	});

	test('a missing message is a no-op', async () => {
		const { db } = open();
		await organizeInbound(db, 'user-1', 'missing', quietHeaders);
	});
});

describe('applyFilterActions', () => {
	test('applies label, flags, and category on the conversation and does not send', async () => {
		const { sqlite, db } = open();
		addEmail(sqlite, { id: 'old', createdAt: '2026-01-01 00:00:00' });
		addEmail(sqlite, { id: 'new', createdAt: '2026-01-02 00:00:00' });
		sqlite.run(`INSERT INTO labels (id, user_id, name) VALUES ('label-bills', 'user-1', 'Bills')`);

		await applyFilterActions(db, 'user-1', 'new', {
			actionLabelId: 'label-bills',
			actionSkipInbox: true,
			actionStar: true,
			actionImportant: true,
			actionMarkRead: true,
			actionTrash: true,
			actionCategory: 'social',
			actionForwardTo: 'boss@elsewhere.test'
		});

		for (const id of ['old', 'new']) {
			const row = stored(sqlite, id);
			expect(row.in_inbox).toBe(0);
			expect(row.is_starred).toBe(1);
			expect(row.is_important).toBe(1);
			expect(row.is_read).toBe(1);
			expect(row.deleted_at).not.toBeNull();
			expect(row.category).toBe('social');
		}
		const labels = sqlite.query(`SELECT COUNT(*) AS n FROM thread_labels`).get() as { n: number };
		expect(labels.n).toBe(1);
	});

	test('an unknown category is left unchanged', async () => {
		const { sqlite, db } = open();
		addEmail(sqlite, { id: 'new', threadId: 'new', category: 'primary' });

		await applyFilterActions(db, 'user-1', 'new', { actionCategory: 'nope' });

		expect(stored(sqlite, 'new').category).toBe('primary');
	});
});

describe('inbound paths', () => {
	function bucket(): R2Bucket {
		return {
			async put() {
				return null;
			}
		} as unknown as R2Bucket;
	}

	test('Resend stores unsubscribe headers, files from those headers, and forwards', async () => {
		const { sqlite, db } = open();
		seedSendingIdentity(sqlite);
		addFilter(sqlite, {
			id: 'files',
			position: 1,
			matchAttachment: 1,
			star: 1,
			forwardTo: 'boss@elsewhere.test'
		});
		const sent: Array<{ subject: string; text: string }> = [];
		const client = {
			async getReceivedEmail() {
				return {
					from: 'Ada <ada@example.com>',
					to: ['me@cloudmail.test'],
					subject: 'Hello',
					text: 'plain body',
					html: null,
					headers: {
						'List-Unsubscribe': '<https://ex.test/u>',
						'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
						'List-Id': '<list.example.com>',
						'In-Reply-To': '<parent@example.com>'
					}
				};
			},
			async listReceivedAttachments() {
				return [
					{
						id: 'att-1',
						filename: 'note.txt',
						content_type: 'text/plain',
						size: 4,
						download_url: 'https://files.test/note'
					}
				];
			},
			async downloadAttachment() {
				return new TextEncoder().encode('note');
			}
		} as unknown as ResendClient;

		const outcome = await handleResendWebhook(
			{ type: 'email.received', data: { email_id: 'prov-1' } },
			{
				DB: db,
				ATTACHMENTS: bucket(),
				provider: provider(async (input) => {
					sent.push({ subject: input.subject, text: input.text });
					return { providerId: 'fwd-1' };
				})
			},
			client
		);

		expect(outcome.handled).toBe(true);
		const row = sqlite
			.query(
				`SELECT category, is_starred, list_unsubscribe, list_unsubscribe_post, from_addr, from_name
				 FROM emails WHERE provider_id = 'prov-1'`
			)
			.get() as {
			category: string;
			is_starred: number;
			list_unsubscribe: string;
			list_unsubscribe_post: string;
			from_addr: string;
			from_name: string | null;
		};
		expect(row.from_addr).toBe('ada@example.com');
		expect(row.from_name).toBe('Ada');
		expect(row.list_unsubscribe).toBe('<https://ex.test/u>');
		expect(row.list_unsubscribe_post).toBe('List-Unsubscribe=One-Click');
		expect(row.category).toBe('forums');
		expect(row.is_starred).toBe(1);
		expect(sent).toEqual([{ subject: 'Fwd: Hello', text: 'plain body' }]);
		const files = sqlite.query(`SELECT COUNT(*) AS n FROM email_attachments`).get() as { n: number };
		expect(files.n).toBe(1);
	});

	test('a filter failure is logged and does not fail the Resend webhook', async () => {
		const { sqlite, db } = open();
		seedSendingIdentity(sqlite);
		addFilter(sqlite, { id: 'bad', position: 1, matchFrom: 'ada@', labelId: 'missing-label' });
		const errors = spyOn(console, 'error').mockImplementation(() => {});
		const client = {
			async getReceivedEmail() {
				return {
					from: 'ada@example.com',
					to: ['me@cloudmail.test'],
					subject: 'Hello',
					text: 'plain body',
					html: null,
					headers: { 'List-Unsubscribe': '<https://ex.test/u>' }
				};
			},
			async listReceivedAttachments() {
				return [];
			}
		} as unknown as ResendClient;

		try {
			const outcome = await handleResendWebhook(
				{ type: 'email.received', data: { email_id: 'prov-2' } },
				{ DB: db, ATTACHMENTS: bucket() },
				client
			);
			expect(outcome.handled).toBe(true);
			const row = sqlite
				.query(
					`SELECT list_unsubscribe, category, from_addr, from_name FROM emails WHERE provider_id = 'prov-2'`
				)
				.get() as {
				list_unsubscribe: string;
				category: string;
				from_addr: string;
				from_name: string | null;
			};
			expect(row.from_addr).toBe('ada@example.com');
			expect(row.from_name).toBeNull();
			expect(row.list_unsubscribe).toBe('<https://ex.test/u>');
			expect(row.category).toBe('promotions');
			expect(errors.mock.calls.some((call) => call[0] === 'Failed to organize inbound mail')).toBe(
				true
			);
		} finally {
			errors.mockRestore();
		}
	});

	test('Cloudflare stores unsubscribe headers from message.headers and files the message', async () => {
		const { sqlite, db } = open();
		seedSendingIdentity(sqlite);
		const mime = [
			'From: Ada <ada@example.com>',
			'To: me@cloudmail.test',
			'Subject: Cloudflare hello',
			'Message-ID: <cf-msg@example.com>',
			'',
			'Body from cloudflare'
		].join('\r\n');

		await handleCloudflareInbound(
			{
				from: 'ada@example.com',
				to: 'me@cloudmail.test',
				headers: new Headers({
					'list-unsubscribe': '<https://ex.test/u>',
					'list-unsubscribe-post': 'List-Unsubscribe=One-Click',
					'list-id': '<list.example.com>',
					'in-reply-to': '<parent@example.com>'
				}),
				raw: new Response(mime).body as ReadableStream<Uint8Array>,
				setReject() {}
			},
			{ DB: db, ATTACHMENTS: bucket() }
		);

		const row = sqlite
			.query(
				`SELECT category, list_unsubscribe, list_unsubscribe_post, subject, from_addr, from_name
				 FROM emails WHERE from_addr = 'ada@example.com'`
			)
			.get() as {
			category: string;
			list_unsubscribe: string;
			list_unsubscribe_post: string;
			subject: string;
			from_addr: string;
			from_name: string | null;
		};
		expect(row.from_addr).toBe('ada@example.com');
		expect(row.from_name).toBe('Ada');
		expect(row.subject).toBe('Cloudflare hello');
		expect(row.list_unsubscribe).toBe('<https://ex.test/u>');
		expect(row.list_unsubscribe_post).toBe('List-Unsubscribe=One-Click');
		expect(row.category).toBe('forums');
	});
});
