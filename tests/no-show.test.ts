import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import Anthropic from '@anthropic-ai/sdk';
import type { D1Database } from '@cloudflare/workers-types';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { avaDefinition } from '../src/lib/agents/ava';
import { createAgent, decideAction, setAgentStatus } from '../src/lib/server/agents-store';
import { executeAction } from '../src/lib/server/agent-executor';
import type { MessagesClient } from '../src/lib/server/agent-runner';
import { DEFAULT_HOURS } from '../src/lib/calendar/availability';
import { ensureCalendars } from '../src/lib/server/calendar-store';
import { bookSlot, createBookingPage } from '../src/lib/server/booking-store';
import { sendDueBriefs } from '../src/lib/server/prep-brief';
import { draftDueFollowUps } from '../src/lib/server/follow-up';
import { answerCheck, askDueChecks, CheckError, listOpenChecks, pickOffers } from '../src/lib/server/no-show';
import type { EmailProvider } from '../src/lib/server/email-provider';
import type { OutboundMailInput } from '../src/lib/server/send-mail';

const MIGRATIONS = path.join(import.meta.dir, '../migrations');
const CHICAGO = 'America/Chicago';
const NOW = new Date('2026-11-10T15:00:00Z');
const MEETING = '2026-11-12T16:00:00.000Z'; // Thursday 10:00 in Chicago
const END = Date.parse('2026-11-12T16:30:00.000Z');
const GUEST = 'pat@customer-co.com';
const MIN = 60_000;
const at = (ms: number) => new Date(ms);

function adapt(sqlite: Database): D1Database {
	const statement = (sql: string, values: unknown[] = []) => ({
		sql,
		values,
		bind: (...params: unknown[]) => statement(sql, params.map((value) => (value === undefined ? null : value))),
		async first<T>() {
			return (sqlite.query(sql).get(...(values as never[])) as T) ?? null;
		},
		async all<T>() {
			return { results: sqlite.query(sql).all(...(values as never[])) as T[], success: true, meta: {} };
		},
		async run() {
			const info = sqlite.run(sql, values as never[]);
			return { success: true, meta: { changes: info.changes } };
		}
	});
	return {
		prepare: (sql: string) => statement(sql),
		async batch(statements: Array<ReturnType<typeof statement>>) {
			return sqlite.transaction(() => statements.map((s) => sqlite.run(s.sql, s.values as never[])))();
		}
	} as unknown as D1Database;
}

function fakeProvider() {
	const sent: OutboundMailInput[] = [];
	const provider = {
		kind: 'resend',
		async send(input: OutboundMailInput) {
			sent.push(input);
			return { providerId: `p${sent.length}` };
		},
		async listDomains() {
			return [];
		},
		async getDomain() {
			throw new Error('no');
		}
	} as unknown as EmailProvider;
	return { provider, sent };
}

function writer(text = 'Hi Pat,\n\nThanks for your time today.\n\nAva') {
	const client: MessagesClient = {
		async create(params) {
			return {
				id: 'msg',
				type: 'message',
				role: 'assistant',
				model: params.model,
				stop_reason: 'end_turn',
				stop_sequence: null,
				usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
				content: [{ type: 'text', text, citations: null }]
			} as Anthropic.Beta.BetaMessage;
		}
	};
	return { clientFor: async () => client };
}

/** Ava runs demo@, Pat booked Thursday's demo and accepted the invite, and the brief went out. */
async function world(options: { agent?: boolean } = {}) {
	const sqlite = new Database(':memory:');
	sqlite.exec('PRAGMA foreign_keys = ON');
	for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
		sqlite.exec(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
	}
	sqlite.run(`INSERT INTO users (id, email, name, password_hash, is_admin) VALUES ('u1', 'u1@login.test', 'Sada', 'x', 0)`);
	sqlite.run(`INSERT INTO users (id, email, name, password_hash, is_admin) VALUES ('u2', 'u2@login.test', 'Kim', 'x', 1)`);
	sqlite.run(`INSERT INTO domains (id, name) VALUES ('d1', 'acme.com')`);
	sqlite.run(`INSERT INTO addresses (id, user_id, domain_id, address, is_default) VALUES ('a1', 'u1', 'd1', 'sada@acme.com', 1)`);
	sqlite.run(`INSERT INTO addresses (id, user_id, domain_id, address, is_default) VALUES ('a2', 'u1', 'd1', 'demo@acme.com', 0)`);
	sqlite.run(`INSERT INTO addresses (id, user_id, domain_id, address, is_default) VALUES ('a3', 'u2', 'd1', 'kim@acme.com', 1)`);
	const db = adapt(sqlite);
	await ensureCalendars(db, 'u1', { name: 'Sada', timezone: CHICAGO });
	await createBookingPage(
		db,
		'u1',
		['sada@acme.com', 'demo@acme.com'],
		{ slug: 'demo', title: 'Product demo', durations: [30], timezone: CHICAGO, hours: DEFAULT_HOURS, minNoticeMinutes: 60, sendFrom: 'demo@acme.com' },
		NOW
	);
	const { provider, sent } = fakeProvider();
	await bookSlot(
		db,
		provider,
		'demo',
		{ start: MEETING, duration: 30, name: 'Pat Lee', email: GUEST, note: '', timezone: 'America/New_York' },
		{ uidDomain: 'mail.acme.com', origin: 'https://mail.acme.com', now: NOW }
	);
	const ava =
		options.agent === false
			? null
			: await createAgent(db, { ownerUserId: 'u1', displayName: 'Ava', definition: avaDefinition('demo@acme.com', 'Acme') }, NOW);
	if (ava) await setAgentStatus(db, { agentId: ava.id, byUserId: 'u1', status: 'active' });
	sqlite.run(
		`INSERT INTO emails (id, user_id, direction, from_addr, from_name, to_addr, subject, body_text, thread_id, message_id, created_at, security_json)
		 VALUES ('m1', 'u1', 'inbound', ?, 'Pat Lee', 'demo@acme.com', 'Accepted: Product demo', 'See you then.', 'm1', '<m1@customer-co.com>', '2026-11-11T12:00:00.000Z', ?)`,
		[GUEST, JSON.stringify({ auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass', dmarcFrom: ['customer-co.com'] }, verdict: null, reasons: [] })]
	);
	await sendDueBriefs(db, { provider, fetcher: async () => { throw new TypeError('offline'); }, clientFor: async () => null }, new Date('2026-11-12T13:00:00Z'));
	sent.length = 0;
	return { sqlite, db, provider, sent, ava };
}

type World = Awaited<ReturnType<typeof world>>;
const checkId = (w: World) => (w.sqlite.query(`SELECT id FROM booking_checks`).get() as { id: string }).id;
const actions = (w: World) =>
	w.sqlite.query(`SELECT id, status, payload_json, reason, expires_at FROM agent_actions WHERE capability = 'send_reply' ORDER BY created_at`).all() as Array<{
		id: string;
		status: string;
		payload_json: string;
		reason: string;
		expires_at: string;
	}>;

describe('“Did they show?”', () => {
	test('is asked ten minutes after the meeting ends, once, and only you see it', async () => {
		const w = await world();
		expect(await askDueChecks(w.db, at(END + 9 * MIN))).toBe(0);
		expect(await askDueChecks(w.db, at(END + 10 * MIN))).toBe(1);
		expect(await askDueChecks(w.db, at(END + 11 * MIN))).toBe(0);
		const open = await listOpenChecks(w.db, 'u1', at(END + 11 * MIN));
		expect(open).toEqual([
			expect.objectContaining({ agentName: 'Ava', guestName: 'Pat Lee', guestEmail: GUEST, pageTitle: 'Product demo', start: MEETING, timezone: CHICAGO })
		]);
		// Not even an admin sees or answers another person's meeting.
		expect(await listOpenChecks(w.db, 'u2', at(END + 11 * MIN))).toEqual([]);
		await expect(answerCheck(w.db, { checkId: open[0].id, userId: 'u2', answer: 'no_show' }, at(END + 12 * MIN))).rejects.toThrow(
			new CheckError('missing')
		);
	});

	test('isn’t asked for cancelled meetings, or on pages no agent runs', async () => {
		const w = await world();
		w.sqlite.run(`UPDATE bookings SET status = 'cancelled'`);
		expect(await askDueChecks(w.db, at(END + 10 * MIN))).toBe(0);
		const none = await world({ agent: false });
		expect(await askDueChecks(none.db, at(END + 10 * MIN))).toBe(0);
	});

	test('with no answer in a day, they came: the question goes away and nothing happens', async () => {
		const w = await world();
		await askDueChecks(w.db, at(END + 10 * MIN));
		const id = checkId(w);
		expect(await listOpenChecks(w.db, 'u1', at(END + 24 * 60 * MIN + MIN))).toEqual([]);
		expect(w.sqlite.query(`SELECT status FROM booking_checks`).get()).toEqual({ status: 'assumed_showed' });
		await expect(answerCheck(w.db, { checkId: id, userId: 'u1', answer: 'no_show' }, at(END + 25 * 60 * MIN))).rejects.toThrow(new CheckError('expired'));
		expect(actions(w)).toEqual([]);
	});

	test('an answer after the day is up is refused, even before anything tidied it away', async () => {
		const w = await world();
		await askDueChecks(w.db, at(END + 10 * MIN));
		await expect(answerCheck(w.db, { checkId: checkId(w), userId: 'u1', answer: 'no_show' }, at(END + 24 * 60 * MIN + MIN))).rejects.toThrow(
			new CheckError('expired')
		);
		expect(actions(w)).toEqual([]);
	});

	test('“Yes” changes nothing; it can’t be answered twice; nonsense is refused', async () => {
		const w = await world();
		await askDueChecks(w.db, at(END + 10 * MIN));
		const id = checkId(w);
		await expect(answerCheck(w.db, { checkId: id, userId: 'u1', answer: 'maybe' })).rejects.toThrow(new CheckError('answer'));
		expect(await answerCheck(w.db, { checkId: id, userId: 'u1', answer: 'showed' }, at(END + 20 * MIN))).toEqual({ status: 'showed', sorry: 'none' });
		await expect(answerCheck(w.db, { checkId: id, userId: 'u1', answer: 'no_show' }, at(END + 21 * MIN))).rejects.toThrow(new CheckError('answered'));
		expect(actions(w)).toEqual([]);
	});
});

describe('a no-show', () => {
	test('queues “sorry we missed you” on their thread, offering three new times on different days, for your OK', async () => {
		const w = await world();
		await askDueChecks(w.db, at(END + 10 * MIN));
		expect(await answerCheck(w.db, { checkId: checkId(w), userId: 'u1', answer: 'no_show' }, at(END + 20 * MIN))).toEqual({ status: 'no_show', sorry: 'queued' });
		const [action] = actions(w);
		expect(action.status).toBe('queued');
		const payload = JSON.parse(action.payload_json);
		expect(payload).toMatchObject({ emailId: 'm1', from: 'demo@acme.com', to: [GUEST], subject: 'Re: Accepted: Product demo' });
		const body: string = payload.body;
		expect(body).toStartWith('Hi Pat,\n\nSorry we missed you for Product demo.');
		const offers = body.split('\n').filter((line) => line.startsWith('- '));
		expect(offers.length).toBe(3);
		// In Pat's own zone, on three different days.
		expect(offers.every((line) => line.endsWith(' EST'))).toBe(true);
		expect(new Set(offers.map((line) => line.split(',').slice(0, 2).join(','))).size).toBe(3);
		expect(body).toContain('here: https://mail.acme.com/book/demo');
		expect(body).toEndWith('Best,\nAva');
		expect(action.reason).toContain('you marked "Product demo" a no-show, offering 3 new times');
		// Never sent late: it lapses when the first time it offers has passed.
		expect(Date.parse(action.expires_at)).toBeGreaterThan(END + 20 * MIN);
		expect(Date.parse(action.expires_at)).toBeLessThan(END + 3 * 24 * 60 * MIN);
	});

	test('approving it sends it to them, with the AI notice', async () => {
		const w = await world();
		await askDueChecks(w.db, at(END + 10 * MIN));
		await answerCheck(w.db, { checkId: checkId(w), userId: 'u1', answer: 'no_show' }, at(END + 20 * MIN));
		const [action] = actions(w);
		await decideAction(w.db, { actionId: action.id, byUserId: 'u1', decision: 'approve' }, at(END + 21 * MIN));
		expect((await executeAction(w.db, action.id, at(END + 21 * MIN), { provider: w.provider })).status).toBe('executed');
		const out = w.sqlite.query(`SELECT to_addr, body_text FROM emails WHERE direction = 'outbound' AND from_addr = 'demo@acme.com'`).get() as Record<string, string>;
		expect(out.to_addr).toBe(GUEST);
		expect(out.body_text).toContain('Sorry we missed you');
		expect(out.body_text).toContain('Ava is an AI assistant working with Sada.');
	});

	test('means no general “thanks for your time” follow-up later', async () => {
		const w = await world();
		await askDueChecks(w.db, at(END + 10 * MIN));
		await answerCheck(w.db, { checkId: checkId(w), userId: 'u1', answer: 'no_show' }, at(END + 20 * MIN));
		expect(await draftDueFollowUps(w.db, writer(), at(END + 121 * MIN))).toBe(0);
		expect(w.sqlite.query(`SELECT follow_up FROM booking_briefs`).get()).toEqual({ follow_up: 'skipped_no_show' });
	});

	test('withdraws a general follow-up already waiting for your OK', async () => {
		const w = await world();
		expect(await draftDueFollowUps(w.db, writer(), at(END + 121 * MIN))).toBe(1);
		await askDueChecks(w.db, at(END + 122 * MIN));
		await answerCheck(w.db, { checkId: checkId(w), userId: 'u1', answer: 'no_show' }, at(END + 130 * MIN));
		expect(actions(w).map((row) => [row.status, JSON.parse(row.payload_json).body.split('\n')[2]])).toEqual([
			['expired', 'Thanks for your time today.'],
			['queued', 'Sorry we missed you for Product demo. No problem at all, these things happen.']
		]);
	});

	test('with no thread with them, goes to your Drafts instead', async () => {
		const w = await world();
		w.sqlite.run(`DELETE FROM emails WHERE id = 'm1'`);
		await askDueChecks(w.db, at(END + 10 * MIN));
		expect(await answerCheck(w.db, { checkId: checkId(w), userId: 'u1', answer: 'no_show' }, at(END + 20 * MIN))).toEqual({ status: 'no_show', sorry: 'draft' });
		const draft = w.sqlite.query(`SELECT from_addr, to_addr, subject, body_text FROM emails WHERE status = 'draft'`).get() as Record<string, string>;
		expect(draft).toMatchObject({ from_addr: 'demo@acme.com', to_addr: GUEST, subject: 'Sorry we missed you: Product demo' });
		expect(draft.body_text).toContain('Ava is an AI assistant working with Sada.');
	});

	test('with the page switched off, offers no times or link, just to find one', async () => {
		const w = await world();
		w.sqlite.run(`UPDATE booking_pages SET enabled = 0`);
		await askDueChecks(w.db, at(END + 10 * MIN));
		await answerCheck(w.db, { checkId: checkId(w), userId: 'u1', answer: 'no_show' }, at(END + 20 * MIN));
		const body: string = JSON.parse(actions(w)[0].payload_json).body;
		expect(body).not.toContain('- ');
		expect(body).not.toContain('/book/');
		expect(body).toContain('reply and I’ll find a new time');
	});

	test('a moved meeting is asked about again, for its new time', async () => {
		const w = await world();
		await askDueChecks(w.db, at(END + 10 * MIN));
		w.sqlite.run(`UPDATE bookings SET start_at = '2026-11-13T16:00:00.000Z', end_at = '2026-11-13T16:30:00.000Z'`);
		expect(await askDueChecks(w.db, at(Date.parse('2026-11-13T16:40:00.000Z')))).toBe(1);
	});
});

describe('picking the times to offer', () => {
	const slot = (date: string, hour: number) => ({ date, start: Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00Z`), end: 0 });

	test('different days first, then fills in, soonest first', () => {
		const slots = [slot('2026-11-13', 15), slot('2026-11-13', 16), slot('2026-11-16', 15), slot('2026-11-17', 15)];
		expect(pickOffers(slots).map((item) => `${item.date} ${new Date(item.start).getUTCHours()}`)).toEqual(['2026-11-13 15', '2026-11-16 15', '2026-11-17 15']);
		expect(pickOffers(slots.slice(0, 3)).map((item) => `${item.date} ${new Date(item.start).getUTCHours()}`)).toEqual(['2026-11-13 15', '2026-11-13 16', '2026-11-16 15']);
		expect(pickOffers([])).toEqual([]);
	});
});
