import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { D1Database } from '@cloudflare/workers-types';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { durationMinutes, parseCalendar, resolveZone } from '../src/lib/calendar/ics-parse';
import { replyFile } from '../src/lib/calendar/ics';
import {
	createEvent,
	deleteEvent,
	ensureCalendars,
	occurrencesInRange,
	seriesOf,
	updateEvent
} from '../src/lib/server/calendar-store';
import {
	describeWhen,
	invitesForEmails,
	isCalendarAttachment,
	listAttendees,
	readGuests,
	recordCalendarMail,
	replaceAttendees,
	respondToInvite,
	sendInvites
} from '../src/lib/server/calendar-invites';
import type { EmailProvider } from '../src/lib/server/email-provider';
import type { OutboundMailInput } from '../src/lib/server/send-mail';
import type { User } from '../src/lib/types';

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
	addUser(sqlite, 'u1', 'Sada', ['sada@acme.com', 'support@acme.com']);
	return { sqlite, db: adapt(sqlite) };
}

let mailCount = 0;
function addMail(
	sqlite: Database,
	input: {
		user?: string;
		to?: string;
		cc?: string;
		from?: string;
		subject?: string;
		body?: string;
		thread?: string;
		direction?: string;
		messageId?: string;
		inReplyTo?: string;
	}
): string {
	const id = `m${++mailCount}`;
	sqlite.run(
		`INSERT INTO emails (id, user_id, direction, from_addr, to_addr, subject, body_text, thread_id, created_at,
		                     cc_addr, message_id, in_reply_to)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			id,
			input.user ?? 'u1',
			input.direction ?? 'inbound',
			input.from ?? 'pat@customer.com',
			input.to ?? 'support@acme.com',
			input.subject ?? 'Help with my order',
			input.body ?? 'Where is my order #123?',
			input.thread ?? id,
			new Date(Date.UTC(2026, 10, 7, 12, mailCount)).toISOString(),
			input.cc ?? null,
			input.messageId ?? null,
			input.inReplyTo ?? null
		]
	);
	return id;
}


const CHICAGO = 'America/Chicago';
const NOW = new Date('2026-11-10T15:00:00Z');
const SADA: User = { id: 'u1', email: 'u1@login.test', name: 'Sada', is_admin: false, created_at: '2026-01-01' };

function setup() {
	const env = open();
	env.sqlite.run(`UPDATE addresses SET is_default = 1 WHERE address = 'sada@acme.com'`);
	return env;
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

function icsOf(mail: OutboundMailInput): string {
	const file = mail.attachments?.[0];
	if (!file) return '';
	// Unfolded, so long lines can be checked whole.
	return new TextDecoder().decode(Uint8Array.from(atob(file.content), (char) => char.charCodeAt(0))).replace(/\r\n /g, '');
}

const GMAIL_INVITE = [
	'BEGIN:VCALENDAR',
	'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
	'VERSION:2.0',
	'METHOD:REQUEST',
	'BEGIN:VEVENT',
	'DTSTART;TZID=America/New_York:20261118T140000',
	'DTEND;TZID=America/New_York:20261118T143000',
	'RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=4',
	'EXDATE;TZID=America/New_York:20261125T140000',
	'DTSTAMP:20261110T150000Z',
	'ORGANIZER;CN=Pat Lee:mailto:pat@customer.com',
	'UID:abc123@google.com',
	'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Pat Lee:mailto:pat@customer.com',
	'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=sada@acme.com:mailto:sada@acme.com',
	'SEQUENCE:0',
	'SUMMARY:Product sync\\, weekly',
	'LOCATION:https://meet.example.com/abc',
	'DESCRIPTION:Agenda:\\n- roadmap\\n- pricing with a long line that the sender folded across',
	'  two lines',
	'STATUS:CONFIRMED',
	'END:VEVENT',
	'END:VCALENDAR'
].join('\r\n');

const OUTLOOK_INVITE = [
	'BEGIN:VCALENDAR',
	'METHOD:REQUEST',
	'PRODID:Microsoft Exchange Server 2010',
	'VERSION:2.0',
	'BEGIN:VTIMEZONE',
	'TZID:Central Standard Time',
	'BEGIN:STANDARD',
	'DTSTART:16010101T020000',
	'TZOFFSETFROM:-0500',
	'TZOFFSETTO:-0600',
	'END:STANDARD',
	'END:VTIMEZONE',
	'BEGIN:VEVENT',
	'ORGANIZER;CN="Lee, Jo":mailto:jo@globex.com',
	'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:sada@acme.com',
	'SUMMARY;LANGUAGE=en-US:Contract review',
	'DTSTART;TZID=Central Standard Time:20261119T100000',
	'DTEND;TZID=Central Standard Time:20261119T110000',
	'UID:040000008200E00074C5B7101A82E008000000@outlook',
	'SEQUENCE:0',
	'END:VEVENT',
	'END:VCALENDAR'
].join('\r\n');

describe('reading invites', () => {
	test('a Gmail invite: zone, repeat, skipped date, guests, folded and escaped text', () => {
		const { method, events } = parseCalendar(GMAIL_INVITE, CHICAGO);
		expect(method).toBe('REQUEST');
		expect(events).toHaveLength(1);
		const event = events[0];
		expect(event).toMatchObject({
			uid: 'abc123@google.com',
			title: 'Product sync, weekly',
			startLocal: '2026-11-18T14:00',
			endLocal: '2026-11-18T14:30',
			timezone: 'America/New_York',
			rrule: 'FREQ=WEEKLY;BYDAY=WE;COUNT=4',
			exdates: ['2026-11-25T14:00'],
			organizer: { email: 'pat@customer.com', name: 'Pat Lee' }
		});
		expect(event.description).toBe('Agenda:\n- roadmap\n- pricing with a long line that the sender folded across two lines');
		expect(event.attendees.map((attendee) => [attendee.email, attendee.partstat])).toEqual([
			['pat@customer.com', 'ACCEPTED'],
			['sada@acme.com', 'NEEDS-ACTION']
		]);
	});

	test("an Outlook invite with Windows zone names and a quoted name", () => {
		const event = parseCalendar(OUTLOOK_INVITE, 'UTC').events[0];
		expect(event).toMatchObject({ timezone: 'America/Chicago', startLocal: '2026-11-19T10:00', title: 'Contract review' });
		expect(event.organizer).toEqual({ email: 'jo@globex.com', name: 'Lee, Jo' });
		// An unknown zone falls back to the file's standard offset.
		expect(resolveZone('Mystery Time', [], 'UTC')).toBe('UTC');
	});

	test('UTC times, all-day dates, durations, and junk', () => {
		const file = [
			'BEGIN:VCALENDAR',
			'BEGIN:VEVENT',
			'UID:a',
			'DTSTART:20261110T150000Z',
			'DURATION:PT45M',
			'SUMMARY:UTC',
			'END:VEVENT',
			'BEGIN:VEVENT',
			'UID:b',
			'DTSTART;VALUE=DATE:20261224',
			'SUMMARY:Holiday',
			'END:VEVENT',
			'BEGIN:VEVENT',
			'SUMMARY:No UID or start',
			'END:VEVENT',
			'END:VCALENDAR'
		].join('\n');
		const events = parseCalendar(file, CHICAGO).events;
		expect(events.map((event) => [event.uid, event.startLocal, event.endLocal, event.timezone])).toEqual([
			['a', '2026-11-10T09:00', '2026-11-10T09:45', CHICAGO],
			['b', '2026-12-24', '2026-12-25', CHICAGO]
		]);
		expect(durationMinutes('P1DT2H')).toBe(1560);
		expect(parseCalendar('not a calendar').events).toEqual([]);
		expect(isCalendarAttachment('text/calendar; method=REQUEST', 'x')).toBe(true);
		expect(isCalendarAttachment('application/octet-stream', 'invite.ics')).toBe(true);
		expect(isCalendarAttachment('application/pdf', 'invite.pdf')).toBe(false);
	});
});

describe('sending invites for your events', () => {
	test('guests get an invite, an update, a cancellation when removed, and one when it is deleted', async () => {
		const { db } = setup();
		const { provider, sent } = fakeProvider();
		const [calendar] = await ensureCalendars(db, 'u1', { name: 'Sada', timezone: CHICAGO });
		const id = await createEvent(db, 'u1', {
			calendarId: calendar.id,
			title: 'Kickoff',
			start: '2026-11-12T10:00',
			end: '2026-11-12T11:00',
			location: 'Room 4'
		});
		await replaceAttendees(db, id, readGuests(['pat@customer.com', { email: 'Lee@Globex.com', name: 'Lee' }, 'sada@acme.com'], ['sada@acme.com']));
		expect((await listAttendees(db, id)).map((guest) => guest.email)).toEqual(['lee@globex.com', 'pat@customer.com']);

		await sendInvites(db, provider, SADA, await seriesOf(db, 'u1', id));
		expect(sent).toHaveLength(1);
		expect(sent[0].from.address).toBe('sada@acme.com');
		expect(sent[0].to).toEqual(['lee@globex.com', 'pat@customer.com']);
		expect(sent[0].subject).toBe('Invitation: Kickoff');
		expect(sent[0].text).toContain('Where: Room 4');
		expect(sent[0].attachments?.[0].type).toBe('text/calendar; method=REQUEST; charset=UTF-8');
		const ics = icsOf(sent[0]);
		expect(ics).toContain('METHOD:REQUEST');
		expect(ics).toContain('ORGANIZER;CN="Sada":mailto:sada@acme.com');
		expect(ics).toContain('ATTENDEE;CN="Lee";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:lee@globex.com');
		expect(ics).toContain('DTSTART;TZID=America/Chicago:20261112T100000');

		// Move it and drop Lee: Pat gets the update, Lee a cancellation.
		await updateEvent(db, 'u1', id, { start: '2026-11-12T13:00', end: '2026-11-12T14:00' });
		const { removed } = await replaceAttendees(db, id, readGuests(['pat@customer.com'], []));
		sent.length = 0;
		await sendInvites(db, provider, SADA, await seriesOf(db, 'u1', id), { removed });
		expect(sent.map((mail) => [mail.subject, mail.to])).toEqual([
			['Updated invitation: Kickoff', ['pat@customer.com']],
			['Canceled: Kickoff', ['lee@globex.com']]
		]);
		expect(icsOf(sent[0])).toContain('SEQUENCE:1');
		expect(icsOf(sent[1])).toContain('METHOD:CANCEL');

		// Delete it: everyone left gets a cancellation.
		const series = await seriesOf(db, 'u1', id);
		const attendees = await listAttendees(db, id);
		await deleteEvent(db, 'u1', id);
		sent.length = 0;
		await sendInvites(db, provider, SADA, series, { cancelAll: true, attendees, edits: [] });
		expect(sent.map((mail) => [mail.subject, mail.to])).toEqual([['Canceled: Kickoff', ['pat@customer.com']]]);
		expect(icsOf(sent[0])).toContain('STATUS:CANCELLED');
	});

	test('bad guest lists are refused', () => {
		expect(() => readGuests(['not an address'], [])).toThrow('guests');
		expect(() => readGuests(Array.from({ length: 51 }, (_, i) => `p${i}@x.com`), [])).toThrow('guests');
		expect(readGuests(undefined, [])).toEqual([]);
	});
});

describe('invites others send you', () => {
	function inbound(sqlite: Database, from: string, security = { spf: 'pass', dkim: 'pass', dmarc: 'pass' }) {
		const id = addMail(sqlite, { from, to: 'sada@acme.com', subject: 'Invitation: Product sync' });
		sqlite.run(`UPDATE emails SET category = 'updates' WHERE id = ?`, [id]);
		sqlite.run(`UPDATE emails SET security_json = ? WHERE id = ?`, [
			JSON.stringify({ auth: security, verdict: null, reasons: [] }),
			id
		]);
		return id;
	}

	test('accept puts it on your calendar and tells the organizer; updates and cancels follow', async () => {
		const { sqlite, db } = setup();
		const { provider, sent } = fakeProvider();
		const [calendar] = await ensureCalendars(db, 'u1', { name: 'Sada', timezone: CHICAGO });
		const email = inbound(sqlite, 'pat@customer.com');
		await recordCalendarMail(db, 'u1', email, [GMAIL_INVITE], NOW);

		// Something to answer goes to Primary, whatever the category guess was.
		expect((sqlite.query(`SELECT category FROM emails WHERE id = ?`).get(email) as { category: string }).category).toBe('primary');
		const cards = await invitesForEmails(db, 'u1', [email]);
		expect(cards[email]).toMatchObject({ method: 'REQUEST', title: 'Product sync, weekly', response: null, onCalendar: false });
		expect(cards[email].when).toContain('Wednesday, November 18, 2026, 2:00 PM – 2:30 PM (America/New York)');

		const { eventId, replied } = await respondToInvite(db, provider, SADA, ['sada@acme.com'], cards[email].id, 'ACCEPTED', NOW);
		expect(eventId).toBeTruthy();
		expect(replied).toBe(true);
		expect(sent[0]).toMatchObject({ to: ['pat@customer.com'], subject: 'Accepted: Product sync, weekly' });
		expect(sent[0].from.address).toBe('sada@acme.com');
		const reply = icsOf(sent[0]);
		expect(reply).toContain('METHOD:REPLY');
		expect(reply).toContain('ATTENDEE;CN="Sada";PARTSTAT=ACCEPTED:mailto:sada@acme.com');
		expect(reply).toContain('UID:abc123@google.com');

		const range = () => occurrencesInRange(db, [calendar], Date.parse('2026-11-15T00:00Z'), Date.parse('2026-12-15T00:00Z'));
		let list = await range();
		// Four Wednesdays, minus the skipped 25th.
		expect(list.map((item) => item.startLocal)).toEqual(['2026-11-18T14:00', '2026-12-02T14:00', '2026-12-09T14:00']);
		expect(list[0]).toMatchObject({ organizer: { email: 'pat@customer.com', name: 'Pat Lee' }, myStatus: 'accepted', sourceEmailId: email });
		expect((await invitesForEmails(db, 'u1', [email]))[email]).toMatchObject({ response: 'ACCEPTED', onCalendar: true });

		// The organizer moves it: your copy follows.
		const moved = GMAIL_INVITE.replace('SEQUENCE:0', 'SEQUENCE:1').replace(/T140000/g, 'T150000').replace('T143000', 'T153000');
		await recordCalendarMail(db, 'u1', inbound(sqlite, 'pat@customer.com'), [moved], NOW);
		list = await range();
		expect(list[0].startLocal).toBe('2026-11-18T15:00');
		expect(list[0].myStatus).toBe('accepted');

		// Someone else can't move or cancel it.
		const forged = GMAIL_INVITE.replace('SEQUENCE:0', 'SEQUENCE:5').replace(/T140000/g, 'T060000');
		await recordCalendarMail(db, 'u1', inbound(sqlite, 'mallory@evil.com'), [forged], NOW);
		const cancel = GMAIL_INVITE.replace('METHOD:REQUEST', 'METHOD:CANCEL').replace('STATUS:CONFIRMED', 'STATUS:CANCELLED');
		await recordCalendarMail(db, 'u1', inbound(sqlite, 'mallory@evil.com'), [cancel], NOW);
		// Nor can mail that fails DMARC for the organizer's domain.
		await recordCalendarMail(db, 'u1', inbound(sqlite, 'pat@customer.com', { spf: 'fail', dkim: 'none', dmarc: 'fail' }), [cancel], NOW);
		expect((await range())[0].startLocal).toBe('2026-11-18T15:00');

		// The real organizer cancels.
		await recordCalendarMail(db, 'u1', inbound(sqlite, 'pat@customer.com'), [cancel], NOW);
		expect(await range()).toEqual([]);
	});

	test('declining takes it off; Outlook invites work the same', async () => {
		const { sqlite, db } = setup();
		const { provider, sent } = fakeProvider();
		await ensureCalendars(db, 'u1', { name: 'Sada', timezone: CHICAGO });
		const email = inbound(sqlite, 'jo@globex.com');
		await recordCalendarMail(db, 'u1', email, [OUTLOOK_INVITE], NOW);
		const card = (await invitesForEmails(db, 'u1', [email]))[email];
		await respondToInvite(db, provider, SADA, ['sada@acme.com'], card.id, 'TENTATIVE', NOW);
		expect((await invitesForEmails(db, 'u1', [email]))[email].onCalendar).toBe(true);
		await respondToInvite(db, provider, SADA, ['sada@acme.com'], card.id, 'DECLINED', NOW);
		expect((await invitesForEmails(db, 'u1', [email]))[email]).toMatchObject({ response: 'DECLINED', onCalendar: false });
		expect(sent.map((mail) => mail.subject)).toEqual(['Tentatively accepted: Contract review', 'Declined: Contract review']);
	});

	test("guests' RSVPs update your event, but only their own answer", async () => {
		const { sqlite, db } = setup();
		const [calendar] = await ensureCalendars(db, 'u1', { name: 'Sada', timezone: CHICAGO });
		const id = await createEvent(db, 'u1', { calendarId: calendar.id, title: 'Kickoff', start: '2026-11-12T10:00', end: '2026-11-12T11:00' });
		await replaceAttendees(db, id, readGuests(['pat@customer.com', 'lee@globex.com'], []));
		const { uid } = await seriesOf(db, 'u1', id);
		const rsvp = (who: string, partstat: 'ACCEPTED' | 'DECLINED') =>
			replyFile({
				uid,
				sequence: 0,
				title: 'Kickoff',
				organizer: { email: 'sada@acme.com', name: 'Sada' },
				attendee: { email: who, name: null },
				partstat,
				start: { allDay: false, local: '2026-11-12T10:00', timezone: CHICAGO },
				now: NOW
			});
		await recordCalendarMail(db, 'u1', inbound(sqlite, 'pat@customer.com'), [rsvp('pat@customer.com', 'ACCEPTED')], NOW);
		// Pat can't answer for Lee.
		await recordCalendarMail(db, 'u1', inbound(sqlite, 'pat@customer.com'), [rsvp('lee@globex.com', 'DECLINED')], NOW);
		expect((await listAttendees(db, id)).map((guest) => [guest.email, guest.partstat])).toEqual([
			['lee@globex.com', 'NEEDS-ACTION'],
			['pat@customer.com', 'ACCEPTED']
		]);
		// The RSVP email shows who answered.
		const first = (sqlite.query(`SELECT email_id FROM calendar_invites WHERE method = 'REPLY' ORDER BY rowid LIMIT 1`).get() as { email_id: string }).email_id;
		expect((await invitesForEmails(db, 'u1', [first]))[first]).toMatchObject({
			method: 'REPLY',
			reply: { email: 'pat@customer.com', partstat: 'ACCEPTED' }
		});
	});

	test('when text', () => {
		expect(describeWhen({ allDay: true, startLocal: '2026-12-24', endLocal: '2026-12-25', timezone: CHICAGO, rrule: null })).toBe(
			'Thursday, December 24, 2026 (all day)'
		);
		expect(
			describeWhen({ allDay: false, startLocal: '2026-11-10T09:00', endLocal: '2026-11-10T09:30', timezone: CHICAGO, rrule: 'FREQ=WEEKLY;BYDAY=TU' })
		).toBe('Tuesday, November 10, 2026, 9:00 AM – 9:30 AM (America/Chicago). Every week on Tue');
	});

	test("an outsider's invite can't take over one of your own events, and odd RSVP values are cleaned", async () => {
		const { sqlite, db } = setup();
		const { provider } = fakeProvider();
		const [calendar] = await ensureCalendars(db, 'u1', { name: 'Sada', timezone: CHICAGO });
		const id = await createEvent(db, 'u1', { calendarId: calendar.id, title: 'Board meeting', start: '2026-11-18T10:00', end: '2026-11-18T11:00' });
		const { uid } = await seriesOf(db, 'u1', id);
		// The attacker reuses your event's UID.
		const hijack = GMAIL_INVITE.replace('UID:abc123@google.com', `UID:${uid}`).replace('Product sync\\, weekly', 'Moved!');
		const email = inbound(sqlite, 'pat@customer.com');
		await recordCalendarMail(db, 'u1', email, [hijack], NOW);
		const card = (await invitesForEmails(db, 'u1', [email]))[email];
		await expect(respondToInvite(db, provider, SADA, ['sada@acme.com'], card.id, 'ACCEPTED', NOW)).rejects.toMatchObject({ code: 'conflict' });
		const list = await occurrencesInRange(db, [calendar], Date.parse('2026-11-15T00:00Z'), Date.parse('2026-11-25T00:00Z'));
		expect(list.map((item) => [item.title, item.organizer])).toEqual([['Board meeting', null]]);

		// A guest's RSVP with a made-up status is stored as no answer, and failing DMARC doesn't count at all.
		await replaceAttendees(db, id, readGuests(['pat@customer.com', 'lee@globex.com'], []));
		const weird = replyFile({
			uid,
			sequence: 0,
			title: 'x',
			organizer: { email: 'sada@acme.com', name: null },
			attendee: { email: 'pat@customer.com', name: null },
			partstat: 'ACCEPTED',
			start: { allDay: false, local: '2026-11-18T10:00', timezone: CHICAGO },
			now: NOW
		}).replace('PARTSTAT=ACCEPTED', 'PARTSTAT=ACCEPTED;X-EVIL=1');
		await recordCalendarMail(db, 'u1', inbound(sqlite, 'pat@customer.com'), [weird.replace('PARTSTAT=ACCEPTED;X-EVIL=1', 'PARTSTAT="ACCEPTED:mailto:x"')], NOW);
		const spoofed = replyFile({
			uid,
			sequence: 0,
			title: 'x',
			organizer: { email: 'sada@acme.com', name: null },
			attendee: { email: 'lee@globex.com', name: null },
			partstat: 'DECLINED',
			start: { allDay: false, local: '2026-11-18T10:00', timezone: CHICAGO },
			now: NOW
		});
		await recordCalendarMail(db, 'u1', inbound(sqlite, 'lee@globex.com', { spf: 'fail', dkim: 'none', dmarc: 'fail' }), [spoofed], NOW);
		expect((await listAttendees(db, id)).map((guest) => [guest.email, guest.partstat])).toEqual([
			['lee@globex.com', 'NEEDS-ACTION'],
			['pat@customer.com', 'NEEDS-ACTION']
		]);
	});

	test("someone pretending to be the organizer can't replace a meeting you already accepted", async () => {
		const { sqlite, db } = setup();
		const { provider } = fakeProvider();
		const [calendar] = await ensureCalendars(db, 'u1', { name: 'Sada', timezone: CHICAGO });
		const real = inbound(sqlite, 'pat@customer.com');
		await recordCalendarMail(db, 'u1', real, [GMAIL_INVITE], NOW);
		await respondToInvite(db, provider, SADA, ['sada@acme.com'], (await invitesForEmails(db, 'u1', [real]))[real].id, 'ACCEPTED', NOW);

		// Same UID and the file says Pat organizes it, but the mail is from someone else.
		const fake = inbound(sqlite, 'mallory@evil.com');
		await recordCalendarMail(db, 'u1', fake, [GMAIL_INVITE.replace(/T140000/g, 'T030000').replace('SEQUENCE:0', 'SEQUENCE:9')], NOW);
		await expect(
			respondToInvite(db, provider, SADA, ['sada@acme.com'], (await invitesForEmails(db, 'u1', [fake]))[fake].id, 'ACCEPTED', NOW)
		).rejects.toMatchObject({ code: 'conflict' });
		const list = await occurrencesInRange(db, [calendar], Date.parse('2026-11-15T00:00Z'), Date.parse('2026-11-20T00:00Z'));
		expect(list.map((item) => item.startLocal)).toEqual(['2026-11-18T14:00']);

		// The real organizer's own update still can be accepted again.
		const update = inbound(sqlite, 'pat@customer.com');
		await recordCalendarMail(db, 'u1', update, [GMAIL_INVITE.replace('SEQUENCE:0', 'SEQUENCE:1')], NOW);
		await respondToInvite(db, provider, SADA, ['sada@acme.com'], (await invitesForEmails(db, 'u1', [update]))[update].id, 'TENTATIVE', NOW);
		expect((await occurrencesInRange(db, [calendar], Date.parse('2026-11-15T00:00Z'), Date.parse('2026-11-20T00:00Z')))[0].myStatus).toBe('tentative');
	});

	test("a guest proposes a new time: their maybe counts, and you can accept or keep the time", async () => {
		const { sqlite, db } = setup();
		const { provider, sent } = fakeProvider();
		const [calendar] = await ensureCalendars(db, 'u1', { name: 'Sada', timezone: CHICAGO });
		const id = await createEvent(db, 'u1', { calendarId: calendar.id, title: 'Test', start: '2026-11-11T08:00', end: '2026-11-11T09:00' });
		await replaceAttendees(db, id, readGuests(['sada.k@gmail.test', 'lee@globex.com'], []));
		const { uid } = await seriesOf(db, 'u1', id);
		// What Gmail sends for "Propose a new time".
		const counter = (who: string, hour: string) =>
			[
				'BEGIN:VCALENDAR',
				'METHOD:COUNTER',
				'BEGIN:VEVENT',
				`DTSTART;TZID=America/Chicago:20261111T${hour}0000`,
				`DTEND;TZID=America/Chicago:20261111T${String(Number(hour) + 1).padStart(2, '0')}0000`,
				`UID:${uid}`,
				'SEQUENCE:0',
				'ORGANIZER;CN=Sada:mailto:sada@acme.com',
				`ATTENDEE;PARTSTAT=TENTATIVE;CN=Guest:mailto:${who}`,
				'SUMMARY:Test',
				'END:VEVENT',
				'END:VCALENDAR'
			].join('\r\n');

		const proposal = inbound(sqlite, 'sada.k@gmail.test');
		await recordCalendarMail(db, 'u1', proposal, [counter('sada.k@gmail.test', '09')], NOW);
		expect((await listAttendees(db, id)).find((guest) => guest.email === 'sada.k@gmail.test')?.partstat).toBe('TENTATIVE');
		const card = (await invitesForEmails(db, 'u1', [proposal]))[proposal];
		expect(card).toMatchObject({ method: 'COUNTER', reply: { email: 'sada.k@gmail.test' } });
		expect(card.when).toContain('9:00 AM – 10:00 AM');
		expect(card.proposal?.current).toContain('8:00 AM – 9:00 AM');

		// Accept: the event moves and every guest gets the update.
		const accepted = await respondToInvite(db, provider, SADA, ['sada@acme.com'], card.id, 'ACCEPTED', NOW);
		expect(accepted.replied).toBe(true);
		const list = await occurrencesInRange(db, [calendar], Date.parse('2026-11-11T00:00Z'), Date.parse('2026-11-12T06:00Z'));
		expect(list.map((item) => item.startLocal)).toEqual(['2026-11-11T09:00']);
		expect(sent.at(-1)).toMatchObject({ subject: 'Updated invitation: Test', to: ['lee@globex.com', 'sada.k@gmail.test'] });

		// Another proposal, kept: only the proposer hears back, with DECLINECOUNTER.
		const second = inbound(sqlite, 'lee@globex.com');
		await recordCalendarMail(db, 'u1', second, [counter('lee@globex.com', '15')], NOW);
		const kept = await respondToInvite(db, provider, SADA, ['sada@acme.com'], (await invitesForEmails(db, 'u1', [second]))[second].id, 'DECLINED', NOW);
		expect(kept.replied).toBe(true);
		expect(sent.at(-1)).toMatchObject({ subject: 'New time declined: Test', to: ['lee@globex.com'] });
		expect(icsOf(sent.at(-1)!)).toContain('METHOD:DECLINECOUNTER');
		expect((await occurrencesInRange(db, [calendar], Date.parse('2026-11-11T00:00Z'), Date.parse('2026-11-12T06:00Z')))[0].startLocal).toBe('2026-11-11T09:00');

		// Someone who isn't a guest can't move your event.
		const stranger = inbound(sqlite, 'mallory@evil.com');
		await recordCalendarMail(db, 'u1', stranger, [counter('mallory@evil.com', '03')], NOW);
		await expect(
			respondToInvite(db, provider, SADA, ['sada@acme.com'], (await invitesForEmails(db, 'u1', [stranger]))[stranger].id, 'ACCEPTED', NOW)
		).rejects.toMatchObject({ code: 'conflict' });
	});
});

