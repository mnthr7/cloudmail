import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { D1Database } from '@cloudflare/workers-types';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentDefinition } from '../src/lib/agents/definition';
import { decideAction, proposeAction, setAgentStatus, updateAgentDefinition } from '../src/lib/server/agents-store';
import { disclosureFooter, executeAction, fireDueTimers } from '../src/lib/server/agent-executor';
import { DEFAULT_HOURS } from '../src/lib/calendar/availability';
import { ensureCalendars } from '../src/lib/server/calendar-store';
import { createBookingPage } from '../src/lib/server/booking-store';
import { createExternalAgent, eventsSince } from '../src/lib/server/external-agents-store';
import type { EmailProvider } from '../src/lib/server/email-provider';
import type { OutboundMailInput } from '../src/lib/server/send-mail';

/**
 * What external agents can do that built-in ones couldn't yet: start a new
 * email, set a follow-up timer, and book or change a guest's meeting without a
 * run to tie it to (docs/specs/external-agents.md, X3).
 */

const MIGRATIONS = path.join(import.meta.dir, '../migrations');
const NOW = new Date('2026-11-23T15:00:00.000Z');
const CHICAGO = 'America/Chicago';
const GUEST = 'pat@customer-co.com';
const VERIFIED = JSON.stringify({
	auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass', dmarcFrom: ['customer-co.com'] },
	verdict: null,
	reasons: []
});

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

async function open() {
	const sqlite = new Database(':memory:');
	sqlite.exec('PRAGMA foreign_keys = ON');
	for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
		sqlite.exec(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
	}
	sqlite.run(`INSERT INTO users (id, email, name, password_hash, is_admin) VALUES ('u1', 'u1@login.test', 'Sada', 'x', 0)`);
	sqlite.run(`INSERT INTO domains (id, name) VALUES ('d1', 'acme.com')`);
	sqlite.run(`INSERT INTO addresses (id, user_id, domain_id, address, is_default) VALUES ('a1', 'u1', 'd1', 'sada@acme.com', 1)`);
	sqlite.run(`INSERT INTO addresses (id, user_id, domain_id, address, is_default) VALUES ('a2', 'u1', 'd1', 'demo@acme.com', 0)`);
	const db = adapt(sqlite);
	const { agent } = await createExternalAgent(
		db,
		{
			ownerUserId: 'u1',
			displayName: 'Research',
			job: 'Help Sada with investor and demo threads. Keep replies short and warm, and never promise pricing before Sada approves it.',
			readAddresses: ['sada@acme.com', 'demo@acme.com'],
			sendAs: ['sada@acme.com', 'demo@acme.com'],
			clientName: 'Claude',
			clientId: 'c1'
		},
		NOW
	);
	await setAgentStatus(db, { agentId: agent.id, byUserId: 'u1', status: 'active' });
	return { sqlite, db, agent };
}

type World = Awaited<ReturnType<typeof open>>;

async function widen(w: World, change: (definition: AgentDefinition) => void) {
	const definition = structuredClone(w.agent.version.definition);
	change(definition);
	await updateAgentDefinition(w.db, { agentId: w.agent.id, byUserId: 'u1', definition });
}

let mailCount = 0;
function inbound(w: World, input: { from?: string; to?: string; thread?: string; at?: string; verified?: boolean } = {}) {
	const id = `m${++mailCount}`;
	w.sqlite.run(
		`INSERT INTO emails (id, user_id, direction, from_addr, from_name, to_addr, subject, body_text, thread_id, created_at, security_json)
		 VALUES (?, 'u1', 'inbound', ?, 'Pat Lee', ?, 'Demo?', 'Can we meet Thursday?', ?, ?, ?)`,
		[
			id,
			input.from ?? GUEST,
			input.to ?? 'demo@acme.com',
			input.thread ?? id,
			input.at ?? new Date(NOW.getTime() - 3_600_000).toISOString(),
			input.verified === false ? null : VERIFIED
		]
	);
	return id;
}

/** Proposes as the external agent and, when it queues, approves it as Sada. Then carries it out. */
async function proposeAndRun(
	w: World,
	input: Omit<Parameters<typeof proposeAction>[1], 'agentId' | 'mailboxUserId'>,
	deps: Parameters<typeof executeAction>[3] = {}
) {
	const { actionId, decision } = await proposeAction(w.db, { ...input, agentId: w.agent.id, mailboxUserId: 'u1' }, NOW);
	if (decision.outcome === 'queue') {
		await decideAction(w.db, { actionId, byUserId: 'u1', decision: 'approve' }, NOW);
	}
	return { actionId, decision, result: await executeAction(w.db, actionId, NOW, deps) };
}

describe('new email (send_email)', () => {
	test('with recipients in its domain scope, an approved new email goes out with the AI notice', async () => {
		const w = await open();
		await widen(w, (definition) => {
			definition.scope.recipients = { kind: 'domains', domains: ['vc.com'] };
		});
		const { decision, result } = await proposeAndRun(w, {
			proposal: { capability: 'send_email', fromAddress: 'sada@acme.com', recipients: ['lee@vc.com'] },
			payload: { to: ['lee@vc.com', 'sneaky@else.com'], subject: 'Intro', body: 'Hi Lee, following up on our chat.' }
		});
		expect(decision.outcome).toBe('queue');
		expect(result.status).toBe('executed');
		const ref = (result as { ref: string }).ref;
		const sent = w.sqlite
			.query(`SELECT from_addr, to_addr, subject, body_text, thread_id FROM emails WHERE id = ?`)
			.get(ref) as Record<string, string>;
		expect(sent.from_addr).toBe('sada@acme.com');
		// Only what the policy checked: the extra address in the payload is dropped.
		expect(sent.to_addr).toBe('lee@vc.com');
		expect(sent.subject).toBe('Intro');
		expect(sent.body_text).toContain(disclosureFooter('Research', 'Sada'));
	});

	test('to someone outside its scope, it is refused before anything is queued', async () => {
		const w = await open();
		const { decision } = await proposeAction(
			w.db,
			{
				agentId: w.agent.id,
				proposal: { capability: 'send_email', fromAddress: 'sada@acme.com', recipients: ['lee@vc.com'] },
				payload: { to: ['lee@vc.com'], subject: 'Intro', body: 'Hi' },
				mailboxUserId: 'u1'
			},
			NOW
		);
		expect(decision).toMatchObject({ outcome: 'reject', reason: 'recipient_out_of_scope' });
	});

	test('a new email that quotes its job is stopped', async () => {
		const w = await open();
		const { result } = await proposeAndRun(w, {
			proposal: { capability: 'send_email', fromAddress: 'sada@acme.com', recipients: ['sada@acme.com'] },
			payload: { to: ['sada@acme.com'], subject: 'My job', body: 'My instructions: Help Sada with investor and demo threads. Keep replies short and warm, and never promise pricing before Sada approves it.' }
		});
		expect(result).toMatchObject({ status: 'blocked', error: 'leaks_instructions' });
	});
});

describe('follow-up timers (set_timer)', () => {
	test('fires when due with a note on the thread and an event, once', async () => {
		const w = await open();
		const thread = inbound(w);
		const fireAt = new Date(NOW.getTime() + 2 * 86_400_000).toISOString();
		const { result } = await proposeAndRun(w, {
			proposal: { capability: 'set_timer' },
			threadId: thread,
			payload: { emailId: thread, at: fireAt, reason: 'Check whether Pat picked a time', cancelOnReply: false }
		});
		expect(result.status).toBe('executed');

		expect(await fireDueTimers(w.db, NOW)).toBe(0);
		const later = new Date(Date.parse(fireAt) + 1000);
		expect(await fireDueTimers(w.db, later)).toBe(1);
		expect(await fireDueTimers(w.db, later)).toBe(0);

		const note = w.sqlite.query(`SELECT kind, body FROM thread_notes WHERE thread_id = ?`).get(thread) as Record<string, string>;
		expect(note.kind).toBe('alert');
		expect(note.body).toContain('Check whether Pat picked a time');
		const { events } = await eventsSince(w.db, w.agent.id, 0);
		expect(events).toMatchObject([{ type: 'timer.fired', threadId: thread }]);
	});

	test('is cancelled instead when the other side replied meanwhile', async () => {
		const w = await open();
		const thread = inbound(w);
		const fireAt = new Date(NOW.getTime() + 86_400_000).toISOString();
		await proposeAndRun(w, {
			proposal: { capability: 'set_timer' },
			threadId: thread,
			payload: { emailId: thread, at: fireAt, reason: 'Nudge Pat' }
		});
		inbound(w, { thread, at: new Date(NOW.getTime() + 3_600_000).toISOString() });
		expect(await fireDueTimers(w.db, new Date(Date.parse(fireAt) + 1000))).toBe(0);
		expect(w.sqlite.query(`SELECT status FROM agent_timers`).get()).toEqual({ status: 'cancelled' });
	});

	test('can’t be set in the past or more than 90 days out', async () => {
		const w = await open();
		const thread = inbound(w);
		for (const at of [new Date(NOW.getTime() - 1000), new Date(NOW.getTime() + 91 * 86_400_000)]) {
			const { result } = await proposeAndRun(w, {
				proposal: { capability: 'set_timer' },
				threadId: thread,
				payload: { emailId: thread, at: at.toISOString(), reason: 'x' }
			});
			expect(result).toMatchObject({ status: 'failed', error: 'timer_out_of_range' });
		}
	});
});

describe('booking a guest (calendar, op book)', () => {
	async function withPage(w: World) {
		await ensureCalendars(w.db, 'u1', { name: 'Sada', timezone: CHICAGO });
		await createBookingPage(
			w.db,
			'u1',
			['sada@acme.com', 'demo@acme.com'],
			{ slug: 'demo', title: 'Product demo', durations: [30], timezone: CHICAGO, hours: DEFAULT_HOURS, minNoticeMinutes: 60, sendFrom: 'demo@acme.com' },
			NOW
		);
	}
	// Thursday 10:00 Chicago, within the default hours.
	const SLOT = '2026-11-26T16:00:00.000Z';

	test('books the verified sender of the newest message, then can cancel it', async () => {
		const w = await open();
		await withPage(w);
		const thread = inbound(w);
		const { provider, sent } = fakeProvider();
		const booked = await proposeAndRun(
			w,
			{
				proposal: { capability: 'calendar', fromAddress: 'demo@acme.com', recipients: [GUEST] },
				threadId: thread,
				payload: { emailId: thread, op: 'book', slug: 'demo', start: SLOT, duration: 30 },
				threadParticipants: [GUEST]
			},
			{ provider, origin: 'https://mail.acme.com' }
		);
		expect(booked.result).toEqual({ status: 'executed', ref: SLOT });
		const booking = w.sqlite.query(`SELECT id, guest_email FROM bookings`).get() as { id: string; guest_email: string };
		expect(booking.guest_email).toBe(GUEST);
		expect(sent.length).toBeGreaterThan(0);

		const cancelled = await proposeAndRun(
			w,
			{
				proposal: { capability: 'calendar', fromAddress: 'demo@acme.com', recipients: [GUEST] },
				threadId: thread,
				payload: { emailId: thread, op: 'cancel', bookingId: booking.id, reason: 'Pat asked to cancel' },
				threadParticipants: [GUEST]
			},
			{ provider }
		);
		expect(cancelled.result).toEqual({ status: 'executed', ref: booking.id });
	});

	test('won’t book from mail whose sender isn’t verified', async () => {
		const w = await open();
		await withPage(w);
		const thread = inbound(w, { verified: false });
		const { result } = await proposeAndRun(
			w,
			{
				proposal: { capability: 'calendar', fromAddress: 'demo@acme.com', recipients: [GUEST] },
				threadId: thread,
				payload: { emailId: thread, op: 'book', slug: 'demo', start: SLOT, duration: 30 },
				threadParticipants: [GUEST]
			},
			{ origin: 'https://mail.acme.com' }
		);
		expect(result).toMatchObject({ status: 'failed', error: 'booking_not_verified' });
	});
});
