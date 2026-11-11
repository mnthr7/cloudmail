import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import Anthropic from '@anthropic-ai/sdk';
import type { D1Database } from '@cloudflare/workers-types';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { avaDefinition } from '../src/lib/agents/ava';
import { createAgent, decideAction, setAgentStatus, updateAgentDefinition } from '../src/lib/server/agents-store';
import { executeAction } from '../src/lib/server/agent-executor';
import { enqueueAskRun, enqueueMailRuns, threadAgent } from '../src/lib/server/agent-runs-store';
import { cloudflareAuthResults, fromDomainVerified, parseAuthResults, resendAuthResults } from '../src/lib/security/phishing';
import { runDueAgents, type MessagesClient } from '../src/lib/server/agent-runner';
import { toolsFor } from '../src/lib/server/agent-brain';
import { DEFAULT_HOURS } from '../src/lib/calendar/availability';
import { ensureCalendars, listCalendars, occurrencesInRange, updateEvent } from '../src/lib/server/calendar-store';
import { bookSlot, createBookingPage } from '../src/lib/server/booking-store';
import type { EmailProvider } from '../src/lib/server/email-provider';
import type { OutboundMailInput } from '../src/lib/server/send-mail';
const MIGRATIONS = path.join(import.meta.dir, '../migrations');

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

function addUser(sqlite: Database, id: string, name: string, addresses: string[], isAdmin = false) {
	sqlite.run(`INSERT INTO users (id, email, name, password_hash, is_admin) VALUES (?, ?, ?, 'x', ?)`, [
		id,
		`${id}@login.test`,
		name,
		isAdmin ? 1 : 0
	]);
	sqlite.run(`INSERT OR IGNORE INTO domains (id, name) VALUES ('d1', 'acme.com')`);
	for (const address of addresses) {
		sqlite.run(`INSERT INTO addresses (id, user_id, domain_id, address) VALUES (?, ?, 'd1', ?)`, [
			`ad_${address}`,
			id,
			address
		]);
	}
}


function open() {
	const sqlite = new Database(':memory:');
	sqlite.exec('PRAGMA foreign_keys = ON');
	for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
		sqlite.exec(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
	}
	addUser(sqlite, 'u1', 'Sada', ['sada@acme.com', 'demo@acme.com']);
	sqlite.run(`UPDATE addresses SET is_default = 1 WHERE address = 'sada@acme.com'`);
	return { sqlite, db: adapt(sqlite) };
}

const CHICAGO = 'America/Chicago';
const NOW = new Date('2026-11-10T15:00:00Z');
const pass = (domain: string) =>
	JSON.stringify({ auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass', dmarcFrom: [domain] }, verdict: null, reasons: [] });
const UNSIGNED = JSON.stringify({ auth: { spf: 'none', dkim: 'none', dmarc: 'none' }, verdict: null, reasons: [] });

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

type Scripted = { content: Anthropic.Beta.BetaMessage['content'] };
function fakeClient(script: Scripted[]) {
	const requests: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
	const client: MessagesClient = {
		async create(params) {
			requests.push(structuredClone(params));
			const next = script.shift();
			if (!next) throw new Error('No scripted response left');
			return {
				id: `msg_${requests.length}`,
				type: 'message',
				role: 'assistant',
				model: params.model,
				stop_reason: next.content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
				stop_sequence: null,
				usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
				...next
			} as Anthropic.Beta.BetaMessage;
		}
	};
	return { client, requests };
}
const toolUse = (name: string, input: Record<string, unknown>, id = `tu_${name}`) =>
	({ type: 'tool_use', id, name, input }) as Anthropic.Beta.BetaToolUseBlock;
const text = (value: string) => ({ type: 'text', text: value, citations: null }) as Anthropic.Beta.BetaTextBlock;

let mailCount = 0;
function inbound(sqlite: Database, input: { from: string; body: string; security?: string; to?: string }): string {
	const id = `m${++mailCount}`;
	sqlite.run(
		`INSERT INTO emails (id, user_id, direction, from_addr, from_name, to_addr, subject, body_text, thread_id, created_at, security_json)
		 VALUES (?, 'u1', 'inbound', ?, 'Pat Lee', ?, 'Re: Invitation: Product demo: Pat Lee', ?, ?, ?, ?)`,
		[id, input.from, input.to ?? 'demo@acme.com', input.body, id, new Date(NOW.getTime() + mailCount * 1000).toISOString(), input.security ?? pass(input.from.split('@')[1])]
	);
	return id;
}

/** A booking page run by Ava at demo@, one booking by Pat, and Ava hired and active. */
async function setup() {
	const env = open();
	const { db } = env;
	await ensureCalendars(db, 'u1', { name: 'Sada', timezone: CHICAGO });
	await createBookingPage(
		db,
		'u1',
		['sada@acme.com', 'demo@acme.com'],
		{ slug: 'demo', title: 'Product demo', durations: [30], timezone: CHICAGO, hours: DEFAULT_HOURS, minNoticeMinutes: 60, sendFrom: 'demo@acme.com' },
		NOW
	);
	const { provider, sent } = fakeProvider();
	const booking = { start: '2026-11-12T16:00:00.000Z', duration: 30, name: 'Pat Lee', email: 'pat@customer.test', note: '', timezone: 'America/New_York' };
	await bookSlot(db, provider, 'demo', booking, { uidDomain: 'mail.acme.com', origin: 'https://mail.acme.com', now: NOW });
	const ava = await createAgent(db, { ownerUserId: 'u1', displayName: 'Ava', definition: avaDefinition('demo@acme.com', 'Acme') }, NOW);
	await setAgentStatus(db, { agentId: ava.id, byUserId: 'u1', status: 'active' });
	const bookingId = (env.sqlite.query(`SELECT id FROM bookings`).get() as { id: string }).id;
	sent.length = 0;
	return { ...env, provider, sent, ava, bookingId };
}

/** You approve every booking change waiting in the queue, the way the Staff page does. */
async function approveCalendar(sqlite: Database, db: D1Database, provider: EmailProvider) {
	const queued = sqlite.query(`SELECT id FROM agent_actions WHERE capability = 'calendar' AND status = 'queued'`).all() as Array<{ id: string }>;
	for (const { id } of queued) {
		await decideAction(db, { actionId: id, byUserId: 'u1', decision: 'approve' }, NOW);
		await executeAction(db, id, NOW, { provider });
	}
	return queued.length;
}

const range = async (db: D1Database) =>
	occurrencesInRange(db, await listCalendars(db, 'u1'), Date.parse('2026-11-10T00:00Z'), Date.parse('2026-11-20T00:00Z'));

describe('Ava handles booking replies', () => {
	test('her template: booking changes and replies ask first; she watches and sends from her address', () => {
		const definition = avaDefinition('demo@acme.com', 'Acme');
		expect(definition.capabilities.calendar).toEqual({ level: 'approve', dailyLimit: 20 });
		expect(definition.capabilities.send_reply?.level).toBe('approve');
		expect(definition.capabilities.send_email?.level).toBe('off');
		expect(definition.triggers).toEqual({ watch: ['demo@acme.com'], teamOnly: false });
		expect(definition.scope.sendAs).toEqual(['demo@acme.com']);
		// Booking tools only when she actually runs a booking page.
		expect(toolsFor(definition, 'mail').map((tool) => tool.name)).not.toContain('reschedule_booking');
		expect(toolsFor(definition, 'mail', { bookings: true }).map((tool) => tool.name)).toEqual([
			'send_reply',
			'draft_reply',
			'write_note',
			'organize',
			'reschedule_booking',
			'cancel_booking'
		]);
	});

	test('"Can we do Thursday at noon?": she sees the booking, moves it, and everyone follows', async () => {
		const { sqlite, db, provider, sent, bookingId } = await setup();
		const email = inbound(sqlite, { from: 'pat@customer.test', body: 'Something came up, can we do Thursday at noon instead?' });
		expect(await enqueueMailRuns(db, 'u1', email, {}, NOW)).toBe(1);
		const { client, requests } = fakeClient([
			{
				content: [
					toolUse('reschedule_booking', { booking_id: bookingId, start: '2026-11-12T18:00:00.000Z', reason: 'Pat asked for Thursday at noon.' }),
					toolUse('send_reply', {
						from: 'demo@acme.com',
						to: ['pat@customer.test'],
						cc: [],
						body: "Done! You're now booked for Thursday at 1:00 PM your time. — Ava",
						reason: 'Confirm the new time.'
					})
				]
			},
			{ content: [text('Moved Pat to Thursday at noon and drafted a confirmation.')] }
		]);
		await runDueAgents(db, { workspaces: ['default'], clientFor: async () => client, provider }, { now: () => NOW });

		// What she saw: the booking (as facts), its open times in both zones, and booking tools.
		const prompt = JSON.stringify(requests[0].messages);
		expect(prompt).toContain(`<booking id=\\"${bookingId}\\"`);
		// The exact value to use, then the time in your zone and theirs (wording varies by date library: "Nov 12, 12:00" or "Nov 12 at 12:00").
		expect(prompt).toMatch(/2026-11-12T18:00:00\.000Z = Thu, Nov 12,? (at )?12:00 PM CST \/ Thu, Nov 12,? (at )?1:00 PM EST/);
		expect(requests[0].tools?.map((tool) => ('name' in tool ? tool.name : ''))).toContain('reschedule_booking');

		// It waits for your OK, then the calendar moves, the guest gets the update, and your note says Ava did it.
		expect((await range(db))[0].startLocal).toBe('2026-11-12T10:00');
		expect(await approveCalendar(sqlite, db, provider)).toBe(1);
		const [event] = await range(db);
		expect(event.startLocal).toBe('2026-11-12T12:00');
		expect(sent.find((mail) => mail.subject.startsWith('Updated invitation'))).toBeTruthy();
		const notice = sent.find((mail) => mail.subject.startsWith('Rescheduled'));
		expect(notice?.text).toContain('Done by Ava, from their email.');
		// Ava did it, not the guest; and the notice is marked so it doesn't wake her again.
		expect(notice?.text).toMatch(/^"[^"]+" with .+ was moved to /);
		expect(notice?.headers?.['X-CloudMail-Notice']).toBe('rescheduled');
		// Her reply waits for your OK.
		const actions = sqlite.query(`SELECT capability, status FROM agent_actions ORDER BY created_at`).all();
		expect(actions).toEqual([
			{ capability: 'calendar', status: 'executed' },
			{ capability: 'send_reply', status: 'queued' }
		]);
	});

	test('"Please cancel": she cancels, everyone is told', async () => {
		const { sqlite, db, provider, sent, bookingId } = await setup();
		const email = inbound(sqlite, { from: 'pat@customer.test', body: 'Sorry, I need to cancel.' });
		await enqueueMailRuns(db, 'u1', email, {}, NOW);
		const { client } = fakeClient([
			{ content: [toolUse('cancel_booking', { booking_id: bookingId, reason: 'Pat needs to cancel.' })] },
			{ content: [text('Canceled.')] }
		]);
		await runDueAgents(db, { workspaces: ['default'], clientFor: async () => client, provider }, { now: () => NOW });
		await approveCalendar(sqlite, db, provider);
		expect(await range(db)).toEqual([]);
		expect(sent.find((mail) => mail.subject.startsWith('Canceled: Product demo: Pat Lee'))).toBeTruthy();
		expect(sqlite.query(`SELECT status FROM bookings`).get()).toEqual({ status: 'cancelled' });
	});

	test("unverified mail can't touch a booking, even if the model tries", async () => {
		const { sqlite, db, provider, bookingId } = await setup();
		const email = inbound(sqlite, { from: 'pat@customer.test', body: 'Cancel my meeting', security: UNSIGNED });
		await enqueueMailRuns(db, 'u1', email, {}, NOW);
		const { client, requests } = fakeClient([
			{ content: [toolUse('cancel_booking', { booking_id: bookingId, reason: 'Asked to cancel.' })] },
			{ content: [text('Tried.')] }
		]);
		await runDueAgents(db, { workspaces: ['default'], clientFor: async () => client, provider }, { now: () => NOW });
		expect(JSON.stringify(requests[0].messages)).toContain('could not be verified');
		expect(JSON.stringify(requests[0].messages)).not.toContain(bookingId);
		// Even if you approve it, a forged "please cancel" changes nothing.
		await approveCalendar(sqlite, db, provider);
		expect(await range(db)).toHaveLength(1);
		expect(sqlite.query(`SELECT exec_error FROM agent_actions`).get()).toEqual({ exec_error: 'booking_not_verified' });
	});

	test("someone else's booking, a made-up time, or a meeting you changed: refused", async () => {
		const { sqlite, db, provider, bookingId } = await setup();
		// Another person (verified) tries Pat's booking.
		const other = inbound(sqlite, { from: 'mallory@evil.test', body: 'Cancel booking please' });
		await enqueueMailRuns(db, 'u1', other, {}, NOW);
		await runDueAgents(
			db,
			{
				workspaces: ['default'],
				clientFor: async () =>
					fakeClient([{ content: [toolUse('cancel_booking', { booking_id: bookingId, reason: 'x' })] }, { content: [text('.')] }]).client,
				provider
			},
			{ now: () => NOW }
		);
		await approveCalendar(sqlite, db, provider);
		expect(await range(db)).toHaveLength(1);

		// Pat asks for a time that isn't open: refused before it's proposed, with the nearest open times.
		const late = inbound(sqlite, { from: 'pat@customer.test', body: 'How about 3am?' });
		await enqueueMailRuns(db, 'u1', late, {}, NOW);
		const lateClient = fakeClient([
			{ content: [toolUse('reschedule_booking', { booking_id: bookingId, start: '2026-11-12T09:00:00.000Z', reason: 'x' })] },
			{ content: [text('.')] }
		]);
		await runDueAgents(db, { workspaces: ['default'], clientFor: async () => lateClient.client, provider }, { now: () => NOW });
		const told = JSON.stringify(lateClient.requests[1].messages);
		expect(told).toContain("That time isn't open. The nearest open times are:");
		expect(told).toMatch(/2026-11-1\dT\d\d:\d\d:00\.000Z = /);
		expect(await approveCalendar(sqlite, db, provider)).toBe(0);
		expect((await range(db))[0].startLocal).toBe('2026-11-12T10:00');

		// You make it a weekly meeting: it's yours now, Ava's hands are off.
		const [event] = await range(db);
		await updateEvent(db, 'u1', event.eventId, { rrule: 'FREQ=WEEKLY' });
		const again = inbound(sqlite, { from: 'pat@customer.test', body: 'Please cancel' });
		await enqueueMailRuns(db, 'u1', again, {}, NOW);
		const { client, requests } = fakeClient([
			{ content: [toolUse('cancel_booking', { booking_id: bookingId, reason: 'x' })] },
			{ content: [text('.')] }
		]);
		await runDueAgents(db, { workspaces: ['default'], clientFor: async () => client, provider }, { now: () => NOW });
		await approveCalendar(sqlite, db, provider);
		expect(JSON.stringify(requests[0].messages)).toContain('no upcoming bookings');
		expect((await range(db)).length).toBeGreaterThan(1);
		const errors = (sqlite.query(`SELECT exec_error FROM agent_actions ORDER BY created_at`).all() as Array<{ exec_error: string }>).map(
			(row) => row.exec_error
		);
		expect(errors).toEqual(['booking_missing', 'booking_changed']);
	});
});

describe('the security review fixes', () => {
	test("a DMARC pass only vouches for the domain it was about", async () => {
		const { parseAuthResults, fromDomainVerified } = await import('../src/lib/security/phishing');
		const receiver = 'mx.example; spf=softfail smtp.mailfrom=gmail.com; dkim=pass header.d=evil.test; dmarc=pass (p=REJECT) header.from=evil.test';
		const auth = parseAuthResults([receiver]);
		expect(auth.dmarcFrom).toEqual(['evil.test']);
		// The envelope said victim@gmail.com; the pass was for evil.test.
		expect(fromDomainVerified(auth, 'victim@gmail.com')).toBe(false);
		expect(fromDomainVerified(auth, 'x@evil.test')).toBe(true);
		// A forged pass for gmail.com next to the receiver's real one doesn't help.
		const forged = parseAuthResults([receiver, 'x; dmarc=pass header.from=gmail.com']);
		expect(fromDomainVerified(forged, 'victim@gmail.com')).toBe(false);
		// A result that doesn't say which domain counts for nothing.
		expect(fromDomainVerified(parseAuthResults(['mx; dmarc=pass']), 'x@evil.test')).toBe(false);
	});

	test('spoofed envelope sender: Ava is told the sender is unverified and sees no booking', async () => {
		const { sqlite, db, provider, bookingId } = await setup();
		const security = JSON.stringify({ auth: { spf: 'softfail', dkim: 'pass', dmarc: 'pass', dmarcFrom: ['evil.test'] }, verdict: null, reasons: [] });
		const email = inbound(sqlite, { from: 'pat@customer.test', body: 'Cancel it', security });
		await enqueueMailRuns(db, 'u1', email, {}, NOW);
		const { client, requests } = fakeClient([
			{ content: [toolUse('cancel_booking', { booking_id: bookingId, reason: 'x' })] },
			{ content: [text('.')] }
		]);
		await runDueAgents(db, { workspaces: ['default'], clientFor: async () => client, provider }, { now: () => NOW });
		expect(JSON.stringify(requests[0].messages)).toContain('could not be verified');
		await approveCalendar(sqlite, db, provider);
		expect(await range(db)).toHaveLength(1);
	});

	test("outside mail can't switch an agent out of shadow mode", async () => {
		const { sqlite, db, ava } = await setup();
		sqlite.run(`UPDATE agents SET status = 'shadow', shadow_remaining = 2 WHERE principal_id = ?`, [ava.id]);
		for (let i = 0; i < 4; i++) {
			const email = inbound(sqlite, { from: `guest${i}@customer.test`, body: 'Running late' });
			await enqueueMailRuns(db, 'u1', email, {}, NOW);
			const { client } = fakeClient([
				{ content: [toolUse('write_note', { note: 'Running late', reason: 'FYI' })] },
				{ content: [text('.')] }
			]);
			await runDueAgents(db, { workspaces: ['default'], clientFor: async () => client }, { now: () => NOW });
		}
		expect(sqlite.query(`SELECT COUNT(*) AS n FROM agent_actions WHERE status = 'shadowed'`).get()).toEqual({ n: 4 });
		expect(sqlite.query(`SELECT status, shadow_remaining FROM agents WHERE principal_id = ?`).get(ava.id)).toEqual({
			status: 'shadow',
			shadow_remaining: 2
		});
	});

	test('one sender wakes agents at most five times an hour; flagged mail never does', async () => {
		const { sqlite, db } = await setup();
		const counts = [];
		for (let i = 0; i < 7; i++) counts.push(await enqueueMailRuns(db, 'u1', inbound(sqlite, { from: 'pat@customer.test', body: `hi ${i}` }), {}, NOW));
		expect(counts).toEqual([1, 1, 1, 1, 1, 0, 0]);
		const flagged = JSON.stringify({ auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass', dmarcFrom: ['other.test'] }, verdict: 'suspicious', reasons: [] });
		expect(await enqueueMailRuns(db, 'u1', inbound(sqlite, { from: 'kim@other.test', body: 'hi', security: flagged }), {}, NOW)).toBe(0);
	});

	test('only the exact address that booked counts (Gmail dots and +tags aside)', async () => {
		const { db } = await setup();
		const { bookingsForGuest } = await import('../src/lib/server/booking-manage');
		const verified = (from: string) => ({ from_addr: from, security_json: pass(from.split('@')[1]) });
		expect(await bookingsForGuest(db, 'u1', verified('pat@customer.test'), ['demo@acme.com'], NOW)).toHaveLength(1);
		expect(await bookingsForGuest(db, 'u1', verified('pat+x@customer.test'), ['demo@acme.com'], NOW)).toHaveLength(0);
		expect(await bookingsForGuest(db, 'u1', verified('pat@customer.test'), ['other@acme.com'], NOW)).toHaveLength(0);
	});
});

describe("Cloudflare's own sender check", () => {
	const cloudflare =
		'ARC-Authentication-Results: i=1; mx.cloudflare.net;\r\n\tdkim=pass header.d=gmail.com header.s=20230601 header.b=abc;\r\n\tdmarc=pass header.from=gmail.com policy.dmarc=none;\r\n\tspf=pass (mx.cloudflare.net: domain of pat@gmail.com designates 209.85.0.1 as permitted sender) smtp.mailfrom=pat@gmail.com\r\n';
	const body = 'Subject: Re: Invitation\r\nFrom: Pat <pat@gmail.com>\r\n\r\nCan we do Thursday?\r\n';

	test('a Gmail reply through Email Routing is verified from the ARC result Cloudflare added on top', () => {
		const results = cloudflareAuthResults(new TextEncoder().encode(`Received: by mx.cloudflare.net\r\n${cloudflare}${body}`));
		const auth = parseAuthResults(results ? [results] : []);
		expect(auth).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'pass', dmarcFrom: ['gmail.com'] });
		expect(fromDomainVerified(auth, 'pat@gmail.com')).toBe(true);
	});

	test("a sender's own fake headers, below Cloudflare's, count for nothing", () => {
		const forged =
			'ARC-Authentication-Results: i=1; mx.cloudflare.net; dmarc=pass header.from=acme.com\r\nAuthentication-Results: mx.cloudflare.net; dmarc=pass header.from=acme.com\r\n';
		const failing = cloudflare.replace('dmarc=pass header.from=gmail.com', 'dmarc=fail header.from=acme.com');
		const results = cloudflareAuthResults(`${failing}${forged}${body}`);
		expect(parseAuthResults(results ? [results] : []).dmarc).toBe('fail');
	});

	test('no ARC set from Cloudflare on top, or one at the hop limit: nothing is trusted', () => {
		expect(cloudflareAuthResults(body)).toBeNull();
		expect(cloudflareAuthResults(`ARC-Authentication-Results: i=1; mx.google.com; dmarc=pass header.from=gmail.com\r\n${body}`)).toBeNull();
		expect(cloudflareAuthResults(cloudflare.replace('i=1', 'i=50') + body)).toBeNull();
		// A header in the body isn't a header.
		expect(cloudflareAuthResults(`Subject: hi\r\n\r\n${cloudflare}`)).toBeNull();
	});
});

describe('you ask Ava about a booking reply', () => {
	test('she can move it even when the mail itself is unverified: you vouch for it, and your note says so', async () => {
		const { sqlite, db, provider, sent, ava, bookingId } = await setup();
		const email = inbound(sqlite, { from: 'pat@customer.test', body: 'Can we do Thursday at noon instead?', security: UNSIGNED });
		await enqueueAskRun(db, { agentId: ava.id, byUserId: 'u1', emailId: email, request: 'Move this to what they asked for and confirm.' }, NOW);
		const { client, requests } = fakeClient([
			{ content: [toolUse('reschedule_booking', { booking_id: bookingId, start: '2026-11-12T18:00:00.000Z', reason: 'Sada asked.' })] },
			{ content: [text('Moved.')] }
		]);
		await runDueAgents(db, { workspaces: ['default'], clientFor: async () => client, provider }, { now: () => NOW });
		expect(JSON.stringify(requests[0].messages)).toContain(`<booking id=\\"${bookingId}\\"`);
		expect(requests[0].tools?.map((tool) => ('name' in tool ? tool.name : ''))).toContain('reschedule_booking');
		expect(await approveCalendar(sqlite, db, provider)).toBe(1);
		expect((await range(db))[0].startLocal).toBe('2026-11-12T12:00');
		expect(sent.find((mail) => mail.subject.startsWith('Rescheduled'))?.text).toContain('Done by Ava, asked by Sada.');
	});

	test("even with the calendar on its own, an asked change to unverified mail waits for your OK and says why", async () => {
		const { sqlite, db, provider, ava, bookingId } = await setup();
		const definition = avaDefinition('demo@acme.com', 'Acme');
		definition.capabilities.calendar = { level: 'auto', dailyLimit: 20 };
		await updateAgentDefinition(db, { agentId: ava.id, byUserId: 'u1', definition }, NOW);
		const email = inbound(sqlite, { from: 'pat@customer.test', body: 'Please cancel.', security: UNSIGNED });
		await enqueueAskRun(db, { agentId: ava.id, byUserId: 'u1', emailId: email, request: 'Handle this.' }, NOW);
		const { client } = fakeClient([
			{ content: [toolUse('cancel_booking', { booking_id: bookingId, reason: 'They asked to cancel.' })] },
			{ content: [text('Queued.')] }
		]);
		await runDueAgents(db, { workspaces: ['default'], clientFor: async () => client, provider }, { now: () => NOW });
		const action = sqlite.query(`SELECT id, status, reason FROM agent_actions WHERE capability = 'calendar'`).get() as { id: string; status: string; reason: string };
		expect(action.status).toBe('queued');
		expect(action.reason).toStartWith('Sender not verified');
		expect(await range(db)).toHaveLength(1);
		// Marked approved without a person deciding: the executor still refuses.
		sqlite.run(`UPDATE agent_actions SET status = 'auto_approved' WHERE id = ?`, [action.id]);
		await executeAction(db, action.id, NOW, { provider });
		expect(await range(db)).toHaveLength(1);
		expect(sqlite.query(`SELECT exec_error FROM agent_actions WHERE id = ?`).get(action.id)).toEqual({ exec_error: 'booking_not_verified' });
	});

	test('an ask on mail you sent (not from a guest) gets no booking tools', async () => {
		const { sqlite, db, provider, ava } = await setup();
		const email = inbound(sqlite, { from: 'pat@customer.test', body: 'x' });
		sqlite.run(`UPDATE emails SET direction = 'outbound', from_addr = 'demo@acme.com' WHERE id = ?`, [email]);
		await enqueueAskRun(db, { agentId: ava.id, byUserId: 'u1', emailId: email, request: 'Cancel it.' }, NOW);
		const { client, requests } = fakeClient([{ content: [text('Nothing to do.')] }]);
		await runDueAgents(db, { workspaces: ['default'], clientFor: async () => client, provider }, { now: () => NOW });
		expect(JSON.stringify(requests[0].messages)).not.toContain('<booking id');
		expect(requests[0].tools?.map((tool) => ('name' in tool ? tool.name : ''))).not.toContain('cancel_booking');
	});
});

describe("Resend's own sender check", () => {
	test("a Gmail reply Resend checked is verified for the From address's domain", () => {
		const results = resendAuthResults({ spf: 'pass', dkim: 'pass', dmarc: 'pass' }, 'pat@gmail.com');
		const auth = parseAuthResults(results ? [results] : []);
		expect(auth).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'pass', dmarcFrom: ['gmail.com'] });
		expect(fromDomainVerified(auth, 'pat@gmail.com')).toBe(true);
	});

	test('a failed or missing check is not', () => {
		const failed = resendAuthResults({ spf: 'pass', dkim: 'fail', dmarc: 'fail' }, 'pat@gmail.com');
		expect(fromDomainVerified(parseAuthResults(failed ? [failed] : []), 'pat@gmail.com')).toBe(false);
		expect(resendAuthResults(null, 'pat@gmail.com')).toBeNull();
		const unknown = resendAuthResults({ dmarc: 'processing_failed' }, 'pat@gmail.com');
		expect(parseAuthResults(unknown ? [unknown] : []).dmarc).toBe('temperror');
	});
});

describe('a note on a thread Ava is working', () => {
	test('goes to her without an @mention', async () => {
		const { sqlite, db, provider, ava } = await setup();
		const email = inbound(sqlite, { from: 'pat@customer.test', body: 'Can we do Thursday?' });
		await enqueueMailRuns(db, 'u1', email, {}, NOW);
		const { client } = fakeClient([{ content: [text('Left a note.')] }]);
		await runDueAgents(db, { workspaces: ['default'], clientFor: async () => client, provider }, { now: () => NOW });
		expect(await threadAgent(db, 'u1', email, [ava.id], NOW)).toBe(ava.id);
		// Not one you may ask, or another thread: nobody.
		expect(await threadAgent(db, 'u1', email, [], NOW)).toBeNull();
		expect(await threadAgent(db, 'u1', 'other-thread', [ava.id], NOW)).toBeNull();
	});

	test('asked from the invite you sent, she works from the guest\'s newest reply on the thread', async () => {
		const { sqlite, db, provider, sent, ava, bookingId } = await setup();
		const invite = inbound(sqlite, { from: 'pat@customer.test', body: 'x' });
		sqlite.run(`UPDATE emails SET direction = 'outbound', from_addr = 'demo@acme.com' WHERE id = ?`, [invite]);
		const reply = inbound(sqlite, { from: 'pat@customer.test', body: 'Can we do Thursday at noon?', security: UNSIGNED });
		sqlite.run(`UPDATE emails SET thread_id = ? WHERE id = ?`, [invite, reply]);
		await enqueueAskRun(db, { agentId: ava.id, byUserId: 'u1', emailId: invite, request: 'Just move the meeting per the request' }, NOW);
		const { client, requests } = fakeClient([
			{ content: [toolUse('reschedule_booking', { booking_id: bookingId, start: '2026-11-12T18:00:00.000Z', reason: 'Asked.' })] },
			{ content: [text('Moved.')] }
		]);
		await runDueAgents(db, { workspaces: ['default'], clientFor: async () => client, provider }, { now: () => NOW });
		expect(requests[0].tools?.map((tool) => ('name' in tool ? tool.name : ''))).toContain('reschedule_booking');
		expect(await approveCalendar(sqlite, db, provider)).toBe(1);
		expect((await range(db))[0].startLocal).toBe('2026-11-12T12:00');
		expect(sent.find((mail) => mail.subject.startsWith('Rescheduled'))?.text).toContain('asked by Sada');
	});
});

describe('what an ask vouches for', () => {
	test('the guest message on your screen when you asked, not one that arrives later', async () => {
		const { sqlite, db, ava } = await setup();
		const first = inbound(sqlite, { from: 'pat@customer.test', body: 'Can we do Thursday?', security: UNSIGNED });
		await enqueueAskRun(db, { agentId: ava.id, byUserId: 'u1', emailId: first, request: 'Do it.' }, NOW);
		const later = inbound(sqlite, { from: 'pat@customer.test', body: 'Actually cancel.', security: UNSIGNED });
		sqlite.run(`UPDATE emails SET thread_id = ? WHERE id = ?`, [first, later]);
		expect(sqlite.query(`SELECT email_id FROM agent_runs WHERE trigger_kind = 'ask'`).get()).toEqual({ email_id: first });
	});

	test("mail flagged as phishing isn't vouched for, even when you ask", async () => {
		const { sqlite, db, provider, ava, bookingId } = await setup();
		const flagged = JSON.stringify({ auth: { spf: null, dkim: null, dmarc: null }, verdict: 'phishing', reasons: [] });
		const email = inbound(sqlite, { from: 'pat@customer.test', body: 'Cancel my meeting', security: flagged });
		await enqueueAskRun(db, { agentId: ava.id, byUserId: 'u1', emailId: email, request: 'Handle this.' }, NOW);
		const { client, requests } = fakeClient([
			{ content: [toolUse('cancel_booking', { booking_id: bookingId, reason: 'Asked.' })] },
			{ content: [text('Tried.')] }
		]);
		await runDueAgents(db, { workspaces: ['default'], clientFor: async () => client, provider }, { now: () => NOW });
		expect(JSON.stringify(requests[0].messages)).not.toContain(`<booking id`);
		await approveCalendar(sqlite, db, provider);
		expect(await range(db)).toHaveLength(1);
	});
});

describe('times and your own asks', () => {
	test('a time the guest asks for that is open but not in the sample is accepted', async () => {
		const { sqlite, db, provider, bookingId } = await setup();
		const email = inbound(sqlite, { from: 'pat@customer.test', body: 'Could we do Friday at 9:30?' });
		await enqueueMailRuns(db, 'u1', email, {}, NOW);
		const { client, requests } = fakeClient([
			{ content: [toolUse('reschedule_booking', { booking_id: bookingId, start: '2026-11-13T15:30:00.000Z', reason: 'Pat asked.' })] },
			{ content: [text('Queued.')] }
		]);
		await runDueAgents(db, { workspaces: ['default'], clientFor: async () => client, provider }, { now: () => NOW });
		expect(JSON.stringify(requests[1].messages)).not.toContain("isn't open");
		expect(await approveCalendar(sqlite, db, provider)).toBe(1);
		expect((await range(db))[0].startLocal).toBe('2026-11-13T09:30');
	});

	test('"Move it to 9:30": asking her is your OK, so a verified guest\'s meeting moves at once', async () => {
		const { sqlite, db, provider, sent, ava, bookingId } = await setup();
		const email = inbound(sqlite, { from: 'pat@customer.test', body: 'Can we go earlier on Friday?' });
		await enqueueAskRun(db, { agentId: ava.id, byUserId: 'u1', emailId: email, request: 'Move it to Friday 9:30' }, NOW);
		const { client } = fakeClient([
			{ content: [toolUse('reschedule_booking', { booking_id: bookingId, start: '2026-11-13T15:30:00.000Z', reason: 'Sada asked.' })] },
			{ content: [text('Moved.')] }
		]);
		await runDueAgents(db, { workspaces: ['default'], clientFor: async () => client, provider }, { now: () => NOW });
		expect((await range(db))[0].startLocal).toBe('2026-11-13T09:30');
		expect(sqlite.query(`SELECT status, decided_by_principal_id FROM agent_actions WHERE capability = 'calendar'`).get()).toEqual({
			status: 'executed',
			decided_by_principal_id: 'p_u1'
		});
		expect(sent.find((mail) => mail.subject.startsWith('Rescheduled'))?.text).toContain('asked by Sada');
	});

	test('an ask approves the booking change and the reply, nothing else she tacks on', async () => {
		const { sqlite, db, provider, ava, bookingId } = await setup();
		const email = inbound(sqlite, { from: 'pat@customer.test', body: 'Can we go earlier on Friday?' });
		await enqueueAskRun(db, { agentId: ava.id, byUserId: 'u1', emailId: email, request: 'Move it to Friday 9:30' }, NOW);
		const { client } = fakeClient([
			{
				content: [
					toolUse('reschedule_booking', { booking_id: bookingId, start: '2026-11-13T15:30:00.000Z', reason: 'Asked.' }),
					toolUse('organize', { action: 'archive', reason: 'Tidy up.' })
				]
			},
			{ content: [text('Done.')] }
		]);
		await runDueAgents(db, { workspaces: ['default'], clientFor: async () => client, provider }, { now: () => NOW });
		const rows = sqlite.query(`SELECT capability, status FROM agent_actions ORDER BY capability`).all();
		expect(rows).toEqual([
			{ capability: 'calendar', status: 'executed' },
			{ capability: 'organize', status: 'queued' }
		]);
	});

	test('one ask approves one booking change: a second one she tries waits for you', async () => {
		const { sqlite, db, provider, ava, bookingId } = await setup();
		const email = inbound(sqlite, { from: 'pat@customer.test', body: 'Earlier on Friday?' });
		await enqueueAskRun(db, { agentId: ava.id, byUserId: 'u1', emailId: email, request: 'Move it to Friday 9:30' }, NOW);
		const { client } = fakeClient([
			{ content: [toolUse('reschedule_booking', { booking_id: bookingId, start: '2026-11-13T15:30:00.000Z', reason: 'Asked.' }, 'tu_1')] },
			{ content: [toolUse('cancel_booking', { booking_id: bookingId, reason: 'Changed my mind.' }, 'tu_2')] },
			{ content: [text('Done.')] }
		]);
		await runDueAgents(db, { workspaces: ['default'], clientFor: async () => client, provider }, { now: () => NOW });
		expect(sqlite.query(`SELECT status FROM agent_actions WHERE capability = 'calendar' ORDER BY created_at`).all()).toEqual([
			{ status: 'executed' },
			{ status: 'queued' }
		]);
		expect((await range(db))[0].startLocal).toBe('2026-11-13T09:30');
	});
});

