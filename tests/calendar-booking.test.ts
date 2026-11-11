import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { D1Database } from '@cloudflare/workers-types';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_HOURS, freeSlots, readHours } from '../src/lib/calendar/availability';
import { FEED_LIMITS, parseCalendar } from '../src/lib/calendar/ics-parse';
import {
	CalendarError,
	createEvent,
	deleteEvent,
	ensureCalendars,
	eventsByUid,
	listCalendars,
	occurrencesInRange,
	updateEvent
} from '../src/lib/server/calendar-store';
import {
	addOutsideCalendar,
	eventsToKeep,
	readFeedUrl,
	refreshOutsideCalendar,
	removeOutsideCalendar,
	setOutsideDetails,
	syncDueOutsideCalendars,
	type Fetcher
} from '../src/lib/server/outside-calendars';
import { BookingError, bookSlot, cleanName, guestKey, createBookingPage, openSlots, publicPage, updateBookingPage } from '../src/lib/server/booking-store';
import { listAttendees } from '../src/lib/server/calendar-invites';
import { cancelBooking, manageSlots, manageView, rescheduleBooking, sendDueReminders, bookingForEvent } from '../src/lib/server/booking-manage';
import { importMasterKey } from '../src/lib/server/secret-box';
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
	addUser(sqlite, 'u1', 'Sada', ['sada@acme.com', 'support@acme.com']);
	sqlite.run(`UPDATE addresses SET is_default = 1 WHERE address = 'sada@acme.com'`);
	return { sqlite, db: adapt(sqlite) };
}

const CHICAGO = 'America/Chicago';
const NOW = new Date('2026-11-10T15:00:00Z'); // Tuesday 9:00 in Chicago
const key = await importMasterKey(btoa(String.fromCharCode(...new Uint8Array(32).fill(7))));

const FEED = [
	'BEGIN:VCALENDAR',
	'VERSION:2.0',
	'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
	'BEGIN:VEVENT',
	'UID:standup@google.com',
	'DTSTART;TZID=America/Chicago:20261102T100000',
	'DTEND;TZID=America/Chicago:20261102T103000',
	'RRULE:FREQ=WEEKLY;BYDAY=MO,WE',
	'SUMMARY:Team standup',
	'LOCATION:Room 4',
	'END:VEVENT',
	'BEGIN:VEVENT',
	'UID:standup@google.com',
	'RECURRENCE-ID;TZID=America/Chicago:20261111T100000',
	'DTSTART;TZID=America/Chicago:20261111T100000',
	'DTEND;TZID=America/Chicago:20261111T103000',
	'STATUS:CANCELLED',
	'SUMMARY:Team standup',
	'END:VEVENT',
	'BEGIN:VEVENT',
	'UID:dentist@google.com',
	'DTSTART:20261112T190000Z',
	'DTEND:20261112T200000Z',
	'SUMMARY:Dentist',
	'END:VEVENT',
	'BEGIN:VEVENT',
	'UID:lunch-free@google.com',
	'DTSTART:20261112T170000Z',
	'DTEND:20261112T180000Z',
	'TRANSP:TRANSPARENT',
	'SUMMARY:Maybe lunch',
	'END:VEVENT',
	'BEGIN:VEVENT',
	'UID:old@google.com',
	'DTSTART:20250101T170000Z',
	'DTEND:20250101T180000Z',
	'SUMMARY:Long ago',
	'END:VEVENT',
	'BEGIN:VEVENT',
	'UID:gone@google.com',
	'DTSTART:20261113T170000Z',
	'DTEND:20261113T180000Z',
	'STATUS:CANCELLED',
	'SUMMARY:Canceled meeting',
	'END:VEVENT',
	'END:VCALENDAR'
].join('\r\n');

const LINK = 'webcal://calendar.google.com/calendar/ical/me%40gmail.com/private-abc123/basic.ics';

function feedFetcher(body: () => string | Response) {
	const calls: string[] = [];
	const fetcher: Fetcher = async (url) => {
		calls.push(url);
		const value = body();
		return typeof value === 'string' ? new Response(value, { status: 200 }) : value;
	};
	return { fetcher, calls };
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

const range = (from: string, to: string) => [Date.parse(from), Date.parse(to)] as const;

describe('outside calendar links', () => {
	test('only https links to real hosts are used; webcal is the same thing', () => {
		expect(readFeedUrl(LINK).toString()).toBe('https://calendar.google.com/calendar/ical/me%40gmail.com/private-abc123/basic.ics');
		for (const bad of [
			'http://calendar.google.com/x.ics',
			'https://127.0.0.1/x.ics',
			'https://[::1]/x.ics',
			'https://localhost/x.ics',
			'https://localhost./x.ics',
			'https://box.internal/x.ics',
			'https://user:pass@calendar.google.com/x.ics',
			'https://calendar.google.com:8443/x.ics',
			'file:///etc/passwd',
			'not a link'
		]) {
			expect(() => readFeedUrl(bad)).toThrow(CalendarError);
		}
	});

	test("what's kept: not canceled, not long over, and busy-only skips free time", () => {
		const busyOnly = eventsToKeep(FEED, CHICAGO, false, NOW);
		expect(busyOnly.map((group) => group.series.uid).sort()).toEqual(['dentist@google.com', 'standup@google.com']);
		const standup = busyOnly.find((group) => group.series.uid === 'standup@google.com')!;
		// The canceled Wednesday becomes a skipped date.
		expect(standup.series.exdates).toContain('2026-11-11T10:00');
		expect(standup.edits).toEqual([]);
		const withDetails = eventsToKeep(FEED, CHICAGO, true, NOW);
		expect(withDetails.map((group) => group.series.uid)).toContain('lunch-free@google.com');
	});
});

describe('hostile feeds', () => {
	test('padding with time zones and skip dates stays cheap', () => {
		const lines = ['BEGIN:VCALENDAR'];
		for (let i = 0; i < 20000; i++) lines.push('BEGIN:VTIMEZONE', `TZID:z${i}`, 'END:VTIMEZONE');
		const values = Array.from({ length: 20000 }, () => '20261201T100000').join(',');
		lines.push('BEGIN:VEVENT', 'UID:a', 'DTSTART;TZID=nope:20261101T100000', 'RRULE:FREQ=DAILY', `EXDATE;TZID=nope:${values}`, 'END:VEVENT', 'END:VCALENDAR');
		const started = performance.now();
		const parsed = parseCalendar(lines.join('\r\n'), 'UTC', FEED_LIMITS);
		expect(performance.now() - started).toBeLessThan(2000);
		expect(parsed.events[0].exdates).toHaveLength(500);
	});

	test('at most ten outside calendars', async () => {
		const { db } = open();
		const { fetcher } = feedFetcher(() => FEED);
		for (let i = 0; i < 10; i++) await addOutsideCalendar(db, key, 'u1', { url: LINK, name: `C${i}`, timezone: CHICAGO }, fetcher, NOW);
		await expect(addOutsideCalendar(db, key, 'u1', { url: LINK, name: 'one more', timezone: CHICAGO }, fetcher, NOW)).rejects.toMatchObject({ code: 'limit' });
	});
});

describe('outside calendars on your calendar', () => {
	test('a copy shows as Busy, counts on the calendar, and stays read-only', async () => {
		const { sqlite, db } = open();
		await ensureCalendars(db, 'u1', { name: 'Sada', timezone: CHICAGO });
		const { fetcher, calls } = feedFetcher(() => FEED);
		const { calendar, error } = await addOutsideCalendar(db, key, 'u1', { url: LINK, name: 'Work', timezone: CHICAGO }, fetcher, NOW);
		expect(error).toBeNull();
		expect(calls).toEqual(['https://calendar.google.com/calendar/ical/me%40gmail.com/private-abc123/basic.ics']);
		expect(calendar.source).toMatchObject({ host: 'calendar.google.com', details: false, error: null });

		// The link is stored sealed, never as written.
		const stored = sqlite.query(`SELECT source_url_sealed FROM calendars WHERE id = ?`).get(calendar.id) as { source_url_sealed: string };
		expect(stored.source_url_sealed).not.toContain('private-abc123');

		const calendars = await listCalendars(db, 'u1');
		const list = await occurrencesInRange(db, calendars, ...range('2026-11-09T00:00Z', '2026-11-16T00:00Z'));
		const outside = list.filter((item) => item.calendarId === calendar.id);
		// Mon standup, (Wed canceled), Thu dentist.
		expect(outside.map((item) => [item.title, item.startLocal, item.location])).toEqual([
			['Busy', '2026-11-09T10:00', null],
			['Busy', '2026-11-12T13:00', null]
		]);

		// Read-only: no new events, no edits, no deletes, and invites never match it.
		await expect(
			createEvent(db, 'u1', { calendarId: calendar.id, title: 'x', start: '2026-11-20T09:00', end: '2026-11-20T10:00' })
		).rejects.toMatchObject({ code: 'calendar' });
		const eventId = outside[1].eventId;
		await expect(updateEvent(db, 'u1', eventId, { title: 'Mine now' })).rejects.toMatchObject({ code: 'missing' });
		await expect(deleteEvent(db, 'u1', eventId)).rejects.toMatchObject({ code: 'missing' });
		expect(await eventsByUid(db, 'u1', 'dentist@google.com')).toEqual([]);

		// Titles on: the next refresh copies them.
		await setOutsideDetails(db, 'u1', calendar.id, true);
		await refreshOutsideCalendar(db, key, 'u1', calendar.id, fetcher, NOW);
		const detailed = (await occurrencesInRange(db, await listCalendars(db, 'u1'), ...range('2026-11-09T00:00Z', '2026-11-16T00:00Z'))).filter(
			(item) => item.calendarId === calendar.id
		);
		expect(detailed.map((item) => item.title)).toEqual(['Team standup', 'Maybe lunch', 'Dentist']);
		expect(detailed[0].location).toBe('Room 4');

		await removeOutsideCalendar(db, 'u1', calendar.id);
		expect((await listCalendars(db, 'u1')).some((item) => item.source)).toBe(false);
		expect((sqlite.query(`SELECT COUNT(*) AS n FROM calendar_events`).get() as { n: number }).n).toBe(0);
	});

	test('a broken link keeps the last good copy and says why; the cron refreshes what is due', async () => {
		const { db } = open();
		await ensureCalendars(db, 'u1', { name: 'Sada', timezone: CHICAGO });
		let body: string | Response = FEED;
		const { fetcher, calls } = feedFetcher(() => body);
		const { calendar } = await addOutsideCalendar(db, key, 'u1', { url: LINK, name: 'Work', timezone: CHICAGO }, fetcher, NOW);

		const minutes = (count: number) => new Date(NOW.getTime() + count * 60_000);
		// Refresh now is held back to every couple of minutes.
		expect(await refreshOutsideCalendar(db, key, 'u1', calendar.id, fetcher, minutes(1))).toEqual({ error: null, recent: true });

		body = new Response('gone', { status: 404 });
		const result = await refreshOutsideCalendar(db, key, 'u1', calendar.id, fetcher, minutes(3));
		expect(result.error).toContain('no longer works');
		const count = async () =>
			(await occurrencesInRange(db, await listCalendars(db, 'u1'), ...range('2026-11-09T00:00Z', '2026-11-16T00:00Z'))).length;
		expect(await count()).toBe(2);
		expect((await listCalendars(db, 'u1')).find((item) => item.id === calendar.id)?.source?.error).toContain('no longer works');

		// Redirects are followed only to places that pass the same checks.
		body = new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } });
		expect((await refreshOutsideCalendar(db, key, 'u1', calendar.id, fetcher, minutes(6))).error).toContain('won’t fetch');
		body = new Response(null, { status: 302, headers: { location: 'https://localhost./x.ics' } });
		expect((await refreshOutsideCalendar(db, key, 'u1', calendar.id, fetcher, minutes(9))).error).toContain('won’t fetch');

		body = '<html>Sign in</html>';
		expect((await refreshOutsideCalendar(db, key, 'u1', calendar.id, fetcher, minutes(12))).error).toContain("isn't a calendar");

		// Not due yet; then due 15 minutes later.
		body = FEED;
		calls.length = 0;
		expect(await syncDueOutsideCalendars(db, key, fetcher, minutes(12 + 1))).toBe(0);
		expect(await syncDueOutsideCalendars(db, key, fetcher, minutes(12 + 16))).toBe(1);
		expect(calls).toHaveLength(1);
		expect((await listCalendars(db, 'u1')).find((item) => item.id === calendar.id)?.source?.error).toBeNull();
	});

	test('your own calendar is still made when an outside one exists first', async () => {
		const { db } = open();
		const { fetcher } = feedFetcher(() => FEED);
		await addOutsideCalendar(db, key, 'u1', { url: LINK, name: 'Work', timezone: CHICAGO }, fetcher, NOW);
		const calendars = await ensureCalendars(db, 'u1', { name: 'Sada', timezone: CHICAGO });
		expect(calendars.filter((item) => !item.source)).toHaveLength(1);
		expect(calendars.find((item) => item.isDefault)?.source).toBeNull();
	});
});

describe('open times', () => {
	const rules = {
		timezone: CHICAGO,
		hours: DEFAULT_HOURS,
		durationMinutes: 30,
		bufferMinutes: 0,
		minNoticeMinutes: 0,
		horizonDays: 30,
		maxPerDay: 8
	};
	const local = (slots: Array<{ start: number }>) =>
		slots.map((slot) => new Date(slot.start).toLocaleString('sv-SE', { timeZone: CHICAGO }).slice(0, 16));

	test('weekly hours in the page zone, minus busy time and its buffer', () => {
		const from = Date.parse('2026-11-11T06:00Z'); // Wed 0:00 Chicago
		const to = Date.parse('2026-11-12T06:00Z');
		const all = freeSlots({ rules, busy: [], from, to, now: NOW.getTime() });
		expect(all).toHaveLength(16);
		expect(local(all).slice(0, 2)).toEqual(['2026-11-11 09:00', '2026-11-11 09:30']);
		expect(local(all).at(-1)).toBe('2026-11-11 16:30');

		const busy = [{ start: Date.parse('2026-11-11T16:00Z'), end: Date.parse('2026-11-11T17:00Z') }]; // 10–11
		const withBuffer = freeSlots({ rules: { ...rules, bufferMinutes: 15 }, busy, from, to, now: NOW.getTime() });
		expect(local(withBuffer).slice(0, 3)).toEqual(['2026-11-11 09:00', '2026-11-11 11:30', '2026-11-11 12:00']);
	});

	test('notice, horizon, weekends and the daily limit', () => {
		const from = Date.parse('2026-11-10T06:00Z');
		const to = Date.parse('2026-11-17T06:00Z');
		const soon = freeSlots({ rules: { ...rules, minNoticeMinutes: 240 }, busy: [], from, to, now: NOW.getTime() });
		// Now is Tue 9:00; four hours' notice starts at 13:00. Nothing on the weekend.
		expect(local(soon)[0]).toBe('2026-11-10 13:00');
		expect(local(soon).some((text) => text.startsWith('2026-11-14') || text.startsWith('2026-11-15'))).toBe(false);
		const capped = freeSlots({ rules, busy: [], booked: { '2026-11-11': 8 }, from, to, now: NOW.getTime() });
		expect(local(capped).some((text) => text.startsWith('2026-11-11'))).toBe(false);
		const short = freeSlots({ rules: { ...rules, horizonDays: 1 }, busy: [], from, to, now: NOW.getTime() });
		expect(local(short).every((text) => text < '2026-11-11 09:01')).toBe(true);
	});

	test('hours are checked', () => {
		expect(readHours({ MO: [['09:00', '12:00'], ['13:00', '17:00']] })).toBeTruthy();
		expect(readHours({ MO: [['12:00', '09:00']] })).toBeNull();
		expect(readHours({ MO: [['09:00', '12:00'], ['11:00', '13:00']] })).toBeNull();
		expect(readHours({ XX: [['09:00', '12:00']] })).toBeNull();
		expect(readHours({ MO: [['9am', '5pm']] })).toBeNull();
	});
});

describe('booking pages', () => {
	async function setup() {
		const env = open();
		await ensureCalendars(env.db, 'u1', { name: 'Sada', timezone: CHICAGO });
		const page = await createBookingPage(env.db, 'u1', ['sada@acme.com', 'support@acme.com'], {
			slug: 'sada',
			title: 'Intro call',
			durations: [30, 60],
			timezone: CHICAGO,
			hours: DEFAULT_HOURS,
			bufferMinutes: 0,
			minNoticeMinutes: 60,
			sendFrom: 'support@acme.com'
		}, NOW);
		return { ...env, page };
	}

	test('settings are checked and links are unique', async () => {
		const { db } = await setup();
		const make = (input: Record<string, unknown>) => createBookingPage(db, 'u1', ['sada@acme.com'], { title: 'x', timezone: CHICAGO, ...input }, NOW);
		await expect(make({ slug: 'admin' })).rejects.toMatchObject({ code: 'slug' });
		await expect(make({ slug: 'Has Spaces' })).rejects.toMatchObject({ code: 'slug' });
		await expect(make({ slug: 'sada' })).rejects.toMatchObject({ code: 'slug_taken' });
		await expect(make({ slug: 'ok-one', durations: [7] })).rejects.toMatchObject({ code: 'durations' });
		await expect(make({ slug: 'ok-one', sendFrom: 'ceo@other.com' })).rejects.toMatchObject({ code: 'from' });
		await expect(make({ slug: 'ok-one', hours: { MO: [['17:00', '09:00']] } })).rejects.toMatchObject({ code: 'hours' });
		expect((await publicPage(db, 'sada'))).toEqual({
			slug: 'sada',
			title: 'Intro call',
			description: null,
			durations: [30, 60],
			timezone: CHICAGO,
			location: null,
			host: 'Sada',
			askPhone: 'off',
			questions: [],
			allowGuests: false
		});
		expect(await publicPage(db, 'nobody')).toBeNull();
	});

	test('busy time on any calendar, outside ones included, is never offered', async () => {
		const { db } = await setup();
		const { fetcher } = feedFetcher(() => FEED);
		await addOutsideCalendar(db, key, 'u1', { url: LINK, name: 'Work', timezone: CHICAGO }, fetcher, NOW);
		const calendars = await listCalendars(db, 'u1');
		const own = calendars.find((item) => item.isDefault)!;
		await createEvent(db, 'u1', { calendarId: own.id, title: 'Focus', start: '2026-11-12T09:00', end: '2026-11-12T10:00' });
		const slots = await openSlots(db, 'sada', { from: Date.parse('2026-11-12T06:00Z'), to: Date.parse('2026-11-13T06:00Z'), duration: 30 }, NOW);
		const times = slots.map((slot) => new Date(slot.start).toISOString().slice(11, 16));
		expect(times).not.toContain('15:00'); // 9:00 Chicago: Focus
		expect(times).not.toContain('19:00'); // 13:00 Chicago: dentist (outside)
		expect(times).toContain('17:00'); // 11:00 Chicago: "Maybe lunch" is free time
		expect(times[0]).toBe('16:00');
	});

	test('booking puts it on your calendar, invites the guest, and tells you', async () => {
		const { db, sqlite } = await setup();
		const { provider, sent } = fakeProvider();
		const result = await bookSlot(
			db,
			provider,
			'sada',
			{ start: '2026-11-12T16:00:00.000Z', duration: 60, name: 'Pat <script>Lee', email: 'Pat@Customer.com', note: 'About pricing' },
			{ uidDomain: 'mail.acme.com', now: NOW }
		);
		expect(result).toMatchObject({ start: '2026-11-12T16:00:00.000Z', end: '2026-11-12T17:00:00.000Z', invited: true });
		const list = await occurrencesInRange(db, await listCalendars(db, 'u1'), ...range('2026-11-12T00:00Z', '2026-11-13T00:00Z'));
		expect(list.map((item) => [item.title, item.startLocal, item.endLocal])).toEqual([['Intro call: Pat scriptLee', '2026-11-12T10:00', '2026-11-12T11:00']]);
		expect(await listAttendees(db, list[0].eventId)).toMatchObject([{ email: 'pat@customer.com', name: 'Pat scriptLee' }]);

		const invite = sent.find((mail) => (Array.isArray(mail.to) ? mail.to : [mail.to]).includes('pat@customer.com'))!;
		expect(invite.from.address).toBe('support@acme.com');
		// The guest's note goes only to you, never into what's sent to them.
		expect(JSON.stringify(invite)).not.toContain('About pricing');
		const notice = sent.find((mail) => mail.subject.startsWith('New booking'))!;
		expect(notice).toMatchObject({ to: ['support@acme.com'], headers: { 'Reply-To': 'pat@customer.com' } });
		expect(notice.text).toContain('About pricing');
		expect((sqlite.query(`SELECT COUNT(*) AS n FROM bookings WHERE event_id IS NOT NULL`).get() as { n: number }).n).toBe(1);

		// That hour is gone, for any length.
		const book = (start: string, duration = 30, email = 'lee@globex.com') =>
			bookSlot(db, provider, 'sada', { start, duration, name: 'Lee', email, note: '' }, { uidDomain: 'mail.acme.com', now: NOW });
		await expect(book('2026-11-12T16:30:00.000Z')).rejects.toMatchObject({ code: 'taken' });
		await expect(book('2026-11-12T15:30:00.000Z', 60)).rejects.toMatchObject({ code: 'taken' });
		// Not an open time at all (outside hours, or off the half hour).
		await expect(book('2026-11-12T03:00:00.000Z')).rejects.toMatchObject({ code: 'taken' });
		await expect(book('2026-11-12T18:10:00.000Z')).rejects.toMatchObject({ code: 'taken' });
		await expect(book('2026-11-12T18:00:00.000Z', 30, 'not-an-email')).rejects.toMatchObject({ code: 'email' });
	});

	test('limits: three ahead per guest, ten an hour per page; a turned-off page is gone', async () => {
		const { db } = await setup();
		const { provider } = fakeProvider();
		const book = (start: string, email: string) =>
			bookSlot(db, provider, 'sada', { start, duration: 30, name: 'Guest', email, note: null }, { uidDomain: 'x.test', now: NOW });
		await book('2026-11-12T15:00:00.000Z', 'a@x.test');
		await book('2026-11-12T15:30:00.000Z', 'a@x.test');
		await book('2026-11-12T16:00:00.000Z', 'a@x.test');
		await expect(book('2026-11-12T16:30:00.000Z', 'a@x.test')).rejects.toMatchObject({ code: 'too_many' });
		for (let i = 0; i < 7; i++) await book(`2026-11-13T${String(15 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}:00.000Z`, `g${i}@x.test`);
		await expect(book('2026-11-16T15:00:00.000Z', 'late@x.test')).rejects.toMatchObject({ code: 'slow_down' });

		const page = (await publicPage(db, 'sada'))!;
		expect(page).toBeTruthy();
		const id = (await db.prepare(`SELECT id FROM booking_pages WHERE slug = 'sada'`).first<{ id: string }>())!.id;
		await updateBookingPage(db, 'u1', ['sada@acme.com'], id, { enabled: false }, NOW);
		expect(await publicPage(db, 'sada')).toBeNull();
		await expect(openSlots(db, 'sada', { from: NOW.getTime(), to: NOW.getTime() + 86_400_000, duration: 30 }, NOW)).rejects.toBeInstanceOf(BookingError);
	});

	test('one guest however they write their address', () => {
		expect(guestKey('Pat.Lee+book1@Gmail.com')).toBe('patlee@gmail.com');
		expect(guestKey('pat.lee+x@googlemail.com')).toBe('patlee@gmail.com');
		expect(guestKey('pat.lee+x@acme.com')).toBe('pat.lee@acme.com');
	});

	test('the daily limit holds, and +tags count as the same guest', async () => {
		const { db } = await setup();
		const { provider } = fakeProvider();
		const id = (await db.prepare(`SELECT id FROM booking_pages WHERE slug = 'sada'`).first<{ id: string }>())!.id;
		await updateBookingPage(db, 'u1', ['sada@acme.com'], id, { maxPerDay: 2 }, NOW);
		const book = (start: string, email: string) =>
			bookSlot(db, provider, 'sada', { start, duration: 30, name: 'Guest', email, note: null }, { uidDomain: 'x.test', now: NOW });
		await book('2026-11-12T15:00:00.000Z', 'pat+1@gmail.com');
		await book('2026-11-12T16:00:00.000Z', 'p.a.t+2@gmail.com');
		await expect(book('2026-11-12T17:00:00.000Z', 'other@x.test')).rejects.toMatchObject({ code: 'taken' });
		await book('2026-11-13T15:00:00.000Z', 'pat+3@gmail.com');
		await expect(book('2026-11-13T16:00:00.000Z', 'pat+4@gmail.com')).rejects.toMatchObject({ code: 'too_many' });
	});

	test('names are cleaned to letters', () => {
		expect(cleanName('  José  O’Brien-Smith ')).toBe('José O’Brien-Smith');
		expect(cleanName('Dr. Lee')).toBe('Dr Lee');
		expect(cleanName('Visit http://evil.example now')).toBe('Visit httpevilexample now');
		expect(() => cleanName('<>://')).toThrow(BookingError);
	});
});

describe('calendar page', () => {
	test('clicking an event opens the editor (or the read-only card), never itself again', async () => {
		const source = await Bun.file(new URL('../src/routes/calendar/+page.svelte', import.meta.url)).text();
		const start = source.indexOf('function openOccurrence(');
		const body = source.slice(start, source.indexOf('\n\t}\n', start));
		expect(body).toContain('viewing = item');
		expect(body).toContain('editor = { occurrence: item, start: null }');
		expect(body.slice(body.indexOf('{'))).not.toContain('openOccurrence(');
	});
});

describe('booking v2', () => {
	const OWN = ['sada@acme.com', 'support@acme.com'];
	async function setup(extra: Record<string, unknown> = {}) {
		const env = open();
		await ensureCalendars(env.db, 'u1', { name: 'Sada', timezone: CHICAGO });
		const page = await createBookingPage(
			env.db,
			'u1',
			OWN,
			{
				slug: 'demo',
				title: 'Product demo',
				durations: [30],
				timezone: CHICAGO,
				hours: DEFAULT_HOURS,
				minNoticeMinutes: 60,
				locationKind: 'video',
				location: 'https://us02web.zoom.us/j/123456789',
				askPhone: 'required',
				questions: [
					{ label: 'Company', required: true },
					{ label: 'What would you like to see?', long: true }
				],
				allowGuests: true,
				...extra
			},
			NOW
		);
		return { ...env, page };
	}

	const base = {
		start: '2026-11-12T16:00:00.000Z',
		duration: 30,
		name: 'Pat Lee',
		email: 'pat@customer.test',
		note: 'Looking forward',
		phone: '+1 (615) 555-0100',
		answers: { q1: 'Acme Corp', q2: 'Pricing and the agent setup' },
		guests: ['lee@customer.test'],
		timezone: 'Europe/London'
	};
	const opts = { uidDomain: 'mail.acme.com', origin: 'https://mail.acme.com', now: NOW };
	const toOf = (mail: OutboundMailInput) => (Array.isArray(mail.to) ? mail.to : [mail.to]);
	/** The change link, from the copy of the invite only the booker gets. */
	function linkFor(sent: OutboundMailInput[], email = 'pat@customer.test'): string {
		const mine = sent.filter((mail) => toOf(mail).includes(email) && /\/book\/manage#/.test(mail.text)).at(-1);
		const match = mine?.text.match(/https:\/\/mail\.acme\.com\/book\/manage#([A-Za-z0-9_-]{43})/);
		if (!match) throw new Error('no link');
		return match[1];
	}

	test('settings: locations, questions and reminders are checked', async () => {
		const { db } = await setup();
		const make = (input: Record<string, unknown>) =>
			createBookingPage(db, 'u1', OWN, { title: 'x', slug: 'other', timezone: CHICAGO, ...input }, NOW);
		await expect(make({ locationKind: 'video', location: 'http://zoom.us/j/1' })).rejects.toMatchObject({ code: 'location' });
		await expect(make({ locationKind: 'video' })).rejects.toMatchObject({ code: 'location' });
		await expect(make({ locationKind: 'phone_host', location: 'call me' })).rejects.toMatchObject({ code: 'location' });
		await expect(make({ locationKind: 'teleport' })).rejects.toMatchObject({ code: 'location' });
		await expect(make({ questions: Array.from({ length: 6 }, () => ({ label: 'q' })) })).rejects.toMatchObject({ code: 'questions' });
		await expect(make({ questions: [{ label: '' }] })).rejects.toMatchObject({ code: 'questions' });
		await expect(make({ reminderMinutes: 7 })).rejects.toMatchObject({ code: 'numbers' });
		const call = await make({ locationKind: 'phone_guest', askPhone: 'off' });
		expect(call.askPhone).toBe('required');
		expect(call.location).toBeNull();
	});

	test('the public page names the provider, never the link', async () => {
		const { db } = await setup();
		const page = (await publicPage(db, 'demo'))!;
		expect(page.location).toEqual({ kind: 'video', label: 'Zoom' });
		expect(JSON.stringify(page)).not.toContain('123456789');
		expect(page.questions.map((question) => [question.id, question.required])).toEqual([['q1', true], ['q2', false]]);
	});

	test('phone, answers and guests are checked, then shared only where they belong', async () => {
		const { db, sqlite } = await setup();
		const { provider, sent } = fakeProvider();
		const book = (input: Record<string, unknown>) => bookSlot(db, provider, 'demo', { ...base, ...input }, opts);
		await expect(book({ phone: '' })).rejects.toMatchObject({ code: 'phone' });
		await expect(book({ phone: 'call me maybe' })).rejects.toMatchObject({ code: 'phone' });
		await expect(book({ answers: { q2: 'only this' } })).rejects.toMatchObject({ code: 'answers' });
		await expect(book({ guests: ['a@x.test', 'b@x.test', 'c@x.test', 'd@x.test'] })).rejects.toMatchObject({ code: 'guests' });
		await expect(book({ guests: ['not-an-email'] })).rejects.toMatchObject({ code: 'guests' });

		const result = await book({});
		// The change link is never handed back to the browser; it goes to the booker's inbox.
		expect(JSON.stringify(result)).not.toContain('manage');
		const [event] = await occurrencesInRange(db, await listCalendars(db, 'u1'), ...range('2026-11-12T00:00Z', '2026-11-13T00:00Z'));
		expect(event.location).toBe('https://us02web.zoom.us/j/123456789');
		expect(event.description ?? '').not.toContain('/book/manage');
		expect((await listAttendees(db, event.eventId)).map((guest) => guest.email).sort()).toEqual(['lee@customer.test', 'pat@customer.test']);

		// The booker's copy has the link; the extra guest's doesn't.
		const invites = sent.filter((mail) => mail.subject.startsWith('Invitation'));
		expect(invites.map(toOf)).toEqual([['lee@customer.test'], ['pat@customer.test']]);
		expect(invites[0].text).not.toContain('/book/manage');
		const token = linkFor(sent);
		const stored = sqlite.query(`SELECT manage_token_hash FROM bookings`).get() as { manage_token_hash: string };
		expect(stored.manage_token_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(stored.manage_token_hash).not.toBe(token);
		for (const invite of invites) {
			expect(invite.text).toContain('Where: https://us02web.zoom.us/j/123456789');
			for (const secret of ['Acme Corp', 'Pricing and the agent', '615', 'Looking forward']) expect(JSON.stringify(invite)).not.toContain(secret);
		}
		const notice = sent.find((mail) => mail.subject.startsWith('New booking'))!;
		for (const shown of ['Acme Corp', 'Pricing and the agent setup', 'Phone: +1 (615) 555-0100', 'Also invited: lee@customer.test', 'Looking forward']) {
			expect(notice.text).toContain(shown);
		}
		expect(await bookingForEvent(db, 'u1', event.eventId)).toMatchObject({
			name: 'Pat Lee',
			phone: '+1 (615) 555-0100',
			guests: ['lee@customer.test'],
			answers: [
				{ label: 'Company', value: 'Acme Corp' },
				{ label: 'What would you like to see?', value: 'Pricing and the agent setup' }
			]
		});
	});

	test("when you call them, their number stays with you, not every invitee", async () => {
		const { db } = await setup({ locationKind: 'phone_guest', location: null });
		const { provider, sent } = fakeProvider();
		await bookSlot(db, provider, 'demo', base, opts);
		const [event] = await occurrencesInRange(db, await listCalendars(db, 'u1'), ...range('2026-11-12T00:00Z', '2026-11-13T00:00Z'));
		expect(event.location).toBe('Phone call: Sada will call you');
		for (const invite of sent.filter((mail) => mail.subject.startsWith('Invitation'))) expect(invite.text).not.toContain('615');
		expect(sent.find((mail) => mail.subject.startsWith('New booking'))?.text).toContain('+1 (615) 555-0100');
	});

	test('the booker can move it twice; each move changes the link, and everyone follows', async () => {
		const { db } = await setup();
		const { provider, sent } = fakeProvider();
		await bookSlot(db, provider, 'demo', base, opts);
		const token = linkFor(sent);
		expect((await manageView(db, token, NOW))?.booking).toMatchObject({ status: 'confirmed', canChange: true, canReschedule: true, duration: 30 });

		// Its own time doesn't block a move to a time overlapping it.
		const open = await manageSlots(db, token, { from: Date.parse('2026-11-12T06:00Z'), to: Date.parse('2026-11-13T06:00Z') }, NOW);
		expect(open.map((slot) => new Date(slot.start).toISOString())).toContain('2026-11-12T16:00:00.000Z');

		const later = new Date(NOW.getTime() + 60_000);
		const moved = await rescheduleBooking(db, provider, token, '2026-11-12T18:00:00.000Z', { origin: 'https://mail.acme.com', now: later });
		const [event] = await occurrencesInRange(db, await listCalendars(db, 'u1'), ...range('2026-11-12T00:00Z', '2026-11-13T00:00Z'));
		expect([event.startLocal, event.endLocal]).toEqual(['2026-11-12T12:00', '2026-11-12T12:30']);
		const updates = sent.filter((mail) => mail.subject.startsWith('Updated invitation'));
		expect(updates.map(toOf)).toEqual([['lee@customer.test'], ['pat@customer.test']]);
		expect(sent.find((mail) => mail.subject.startsWith('Rescheduled'))?.text).toContain('It was Thursday, November 12, 10:00');

		// The old link is dead; the new one is in the booker's updated invite (and returned to the page that moved it).
		const token2 = linkFor(sent);
		expect(token2).not.toBe(token);
		expect(moved.manageUrl).toBe(`https://mail.acme.com/book/manage#${token2}`);
		expect(await manageView(db, token, later)).toBeNull();
		await expect(rescheduleBooking(db, provider, token, '2026-11-12T19:00:00.000Z', { origin: 'https://x.test', now: later })).rejects.toMatchObject({
			code: 'missing'
		});

		// A taken or made-up time is refused.
		await expect(
			rescheduleBooking(db, provider, token2, '2026-11-12T18:10:00.000Z', { origin: 'https://mail.acme.com', now: later })
		).rejects.toMatchObject({ code: 'taken' });

		// Twice, then the guest writes instead.
		await rescheduleBooking(db, provider, token2, '2026-11-12T19:00:00.000Z', { origin: 'https://mail.acme.com', now: later });
		const token3 = linkFor(sent);
		expect((await manageView(db, token3, later))?.booking.canReschedule).toBe(false);
		await expect(
			rescheduleBooking(db, provider, token3, '2026-11-12T20:00:00.000Z', { origin: 'https://mail.acme.com', now: later })
		).rejects.toMatchObject({ code: 'too_many' });
	});

	test('the booker can cancel: it leaves your calendar, everyone is told, the time opens up', async () => {
		const { db, sqlite } = await setup();
		const { provider, sent } = fakeProvider();
		await bookSlot(db, provider, 'demo', base, opts);
		const token = linkFor(sent);
		await cancelBooking(db, provider, token, 'Something came up', NOW);
		expect(await occurrencesInRange(db, await listCalendars(db, 'u1'), ...range('2026-11-12T00:00Z', '2026-11-13T00:00Z'))).toEqual([]);
		const cancel = sent.find((mail) => mail.subject.startsWith('Canceled: Product demo: Pat Lee'))!;
		expect(cancel.attachments?.[0].type).toContain('method=CANCEL');
		expect(sent.find((mail) => mail.subject.startsWith('Canceled: Product demo with'))?.text).toContain('Something came up');
		expect(sqlite.query(`SELECT status, cancel_reason FROM bookings`).get()).toEqual({ status: 'cancelled', cancel_reason: 'Something came up' });
		expect((await manageView(db, token, NOW))?.booking.status).toBe('cancelled');
		await expect(cancelBooking(db, provider, token, null, NOW)).rejects.toMatchObject({ code: 'cancelled' });
		await bookSlot(db, provider, 'demo', { ...base, email: 'new@x.test', guests: [] }, opts);
	});

	test("once you change the meeting yourself, the guest's link can't touch it", async () => {
		const { db } = await setup();
		const { provider, sent } = fakeProvider();
		await bookSlot(db, provider, 'demo', base, opts);
		const token = linkFor(sent);
		const [event] = await occurrencesInRange(db, await listCalendars(db, 'u1'), ...range('2026-11-12T00:00Z', '2026-11-13T00:00Z'));
		// You make it a weekly meeting.
		await updateEvent(db, 'u1', event.eventId, { rrule: 'FREQ=WEEKLY' });
		expect((await manageView(db, token, NOW))?.booking).toMatchObject({ status: 'changed', canChange: false });
		await expect(cancelBooking(db, provider, token, null, NOW)).rejects.toMatchObject({ code: 'changed' });
		await expect(
			rescheduleBooking(db, provider, token, '2026-11-12T18:00:00.000Z', { origin: 'https://mail.acme.com', now: NOW })
		).rejects.toMatchObject({ code: 'changed' });
		expect(await occurrencesInRange(db, await listCalendars(db, 'u1'), ...range('2026-11-12T00:00Z', '2026-11-20T00:00Z'))).toHaveLength(2);
	});

	test('one person is in at most three upcoming bookings, extra guest or not; a page mails at most 40 people a day', async () => {
		const { db } = await setup({ maxPerDay: 20 });
		const { provider } = fakeProvider();
		const at = (hour: number, minute = 0) => `2026-11-1${2 + Math.floor(hour / 24)}T${String(hour % 24).padStart(2, '0')}:${minute ? '30' : '00'}:00.000Z`;
		const book = (start: string, email: string, guests: string[]) =>
			bookSlot(db, provider, 'demo', { ...base, start, email, guests }, opts);
		await book(at(15), 'a1@x.test', ['victim+1@gmail.com']);
		await book(at(15, 30), 'a2@x.test', ['v.i.c.t.i.m@gmail.com']);
		await book(at(16), 'a3@x.test', ['victim@googlemail.com']);
		await expect(book(at(16, 30), 'a4@x.test', ['victim@gmail.com'])).rejects.toMatchObject({ code: 'too_many' });
		await expect(book(at(16, 30), 'victim+9@gmail.com', [])).rejects.toMatchObject({ code: 'too_many' });
	});

	test('the daily email budget counts every recipient', async () => {
		const { db, sqlite } = await setup({ maxPerDay: 20 });
		const { provider } = fakeProvider();
		const page = sqlite.query(`SELECT id FROM booking_pages WHERE slug = 'demo'`).get() as { id: string };
		sqlite.run(`INSERT INTO booking_sends (id, page_id, kind, recipients, created_at) VALUES ('s1', ?, 'booked', 38, ?)`, [
			page.id,
			NOW.toISOString()
		]);
		// Two more fit; three don't.
		await expect(
			bookSlot(db, provider, 'demo', { ...base, guests: ['g1@x.test', 'g2@x.test'] }, opts)
		).rejects.toMatchObject({ code: 'slow_down' });
		await bookSlot(db, provider, 'demo', { ...base, guests: ['g1@x.test'] }, opts);
		await expect(bookSlot(db, provider, 'demo', { ...base, email: 'z@x.test', guests: [], start: '2026-11-12T18:00:00.000Z' }, opts)).rejects.toMatchObject({
			code: 'slow_down'
		});
	});

	test('two bookings at once: the one that loses the email budget gives its time back', async () => {
		const { db, sqlite } = await setup({ maxPerDay: 20 });
		const { provider, sent } = fakeProvider();
		const page = sqlite.query(`SELECT id FROM booking_pages WHERE slug = 'demo'`).get() as { id: string };
		// Another booking claimed the last of the budget between this one's hold and its claim.
		const realBatch = db.prepare.bind(db);
		let raced = false;
		(db as unknown as { prepare: typeof db.prepare }).prepare = (sql: string) => {
			if (!raced && sql.startsWith('INSERT INTO booking_sends')) {
				raced = true;
				sqlite.run(`INSERT INTO booking_sends (id, page_id, kind, recipients, created_at) VALUES ('race', ?, 'booked', 40, ?)`, [
					page.id,
					NOW.toISOString()
				]);
			}
			return realBatch(sql);
		};
		await expect(bookSlot(db, provider, 'demo', { ...base, guests: [] }, opts)).rejects.toMatchObject({ code: 'slow_down' });
		expect((sqlite.query(`SELECT COUNT(*) AS n FROM bookings`).get() as { n: number }).n).toBe(0);
		expect(sent).toEqual([]);
	});

	test('no changes once it has started; bad links find nothing; a turned-off page still lets guests manage', async () => {
		const { db, page } = await setup();
		const { provider, sent } = fakeProvider();
		await bookSlot(db, provider, 'demo', base, opts);
		const token = linkFor(sent);
		expect(await manageView(db, 'x'.repeat(43), NOW)).toBeNull();
		expect(await manageView(db, null, NOW)).toBeNull();
		await updateBookingPage(db, 'u1', OWN, page.id, { enabled: false }, NOW);
		expect((await manageView(db, token, NOW))?.booking.canChange).toBe(true);
		const during = new Date('2026-11-12T16:10:00Z');
		expect((await manageView(db, token, during))?.booking.canChange).toBe(false);
		await expect(cancelBooking(db, provider, token, null, during)).rejects.toMatchObject({ code: 'past' });
	});

	test('a reminder goes out once, from you, in their time zone', async () => {
		const { db } = await setup({ reminderMinutes: 1440 });
		const { provider, sent } = fakeProvider();
		await bookSlot(db, provider, 'demo', base, opts);
		sent.length = 0;
		expect(await sendDueReminders(db, provider, new Date('2026-11-11T15:00:00Z'))).toBe(0);
		expect(await sendDueReminders(db, provider, new Date('2026-11-11T16:30:00Z'))).toBe(1);
		expect(sent[0]).toMatchObject({ to: ['pat@customer.test'] });
		expect(sent[0].from.address).toBe('sada@acme.com');
		expect(sent[0].subject).toContain('Reminder: Product demo, Thursday, November 12, 4:00');
		expect(sent[0].text).toContain('Where: https://us02web.zoom.us/j/123456789');
		expect(sent[0].text).toContain('use the link in your invitation email');
		expect(await sendDueReminders(db, provider, new Date('2026-11-11T17:00:00Z'))).toBe(0);

		await bookSlot(db, provider, 'demo', { ...base, email: 'late@x.test', guests: [], start: '2026-11-11T20:00:00.000Z' }, {
			...opts,
			now: new Date('2026-11-11T15:00:00Z')
		});
		sent.length = 0;
		await sendDueReminders(db, provider, new Date('2026-11-11T16:00:00Z'));
		expect(sent.filter((mail) => toOf(mail).includes('late@x.test'))).toEqual([]);
	});
});
