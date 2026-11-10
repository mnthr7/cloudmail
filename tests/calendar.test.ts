import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { D1Database } from '@cloudflare/workers-types';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { localToUtc, utcToLocal } from '../src/lib/calendar/time';
import { describeRule, expandRule, formatRule, parseRule, RuleError } from '../src/lib/calendar/recurrence';
import { calendarFile, escapeText, foldLine } from '../src/lib/calendar/ics';
import { presetLabels, presetOf, ruleFor } from '../src/lib/calendar/presets';
import {
	CalendarError,
	calendarForFeedToken,
	createEvent,
	deleteEvent,
	ensureCalendars,
	occurrencesInRange,
	rotateFeedToken,
	updateEvent
} from '../src/lib/server/calendar-store';

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


const CHICAGO = 'America/Chicago';
const at = (iso: string) => Date.parse(iso);
const starts = (list: Array<{ start: number }>) => list.map((item) => new Date(item.start).toISOString().slice(0, 16));

describe('time zones', () => {
	test('wall clock to UTC through daylight-saving changes', () => {
		expect(new Date(localToUtc({ year: 2026, month: 7, day: 1, hour: 9, minute: 0 }, CHICAGO)).toISOString()).toBe('2026-07-01T14:00:00.000Z');
		expect(new Date(localToUtc({ year: 2026, month: 12, day: 1, hour: 9, minute: 0 }, CHICAGO)).toISOString()).toBe('2026-12-01T15:00:00.000Z');
		// 2:30 doesn't exist on spring-forward day: it becomes 3:30.
		const gap = localToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, CHICAGO);
		expect(utcToLocal(gap, CHICAGO)).toEqual({ year: 2026, month: 3, day: 8, hour: 3, minute: 30 });
		// 1:30 happens twice on fall-back day: the first one.
		expect(new Date(localToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, CHICAGO)).toISOString()).toBe('2026-11-01T06:30:00.000Z');
		// Half-hour zones.
		expect(new Date(localToUtc({ year: 2026, month: 1, day: 1, hour: 0, minute: 0 }, 'Asia/Kolkata')).toISOString()).toBe('2025-12-31T18:30:00.000Z');
		// Europe changes on a different weekend from the US.
		expect(new Date(localToUtc({ year: 2026, month: 3, day: 29, hour: 9, minute: 0 }, 'Europe/Berlin')).toISOString()).toBe('2026-03-29T07:00:00.000Z');
	});
});

describe('repeat rules', () => {
	const expand = (rrule: string, start: string, from: string, to: string, timeZone = CHICAGO, excluded?: Set<string>) => {
		const [date, time] = start.split('T');
		const [year, month, day] = date.split('-').map(Number);
		const [hour, minute] = time.split(':').map(Number);
		return starts(
			expandRule({
				rule: parseRule(rrule, timeZone),
				start: { year, month, day, hour, minute },
				timeZone,
				durationMs: 3_600_000,
				rangeStart: at(from),
				rangeEnd: at(to),
				excluded
			})
		);
	};

	test('weekly stays at 9:00 local across the clock change', () => {
		expect(expand('FREQ=WEEKLY', '2026-10-26T09:00', '2026-10-20T00:00Z', '2026-11-15T00:00Z')).toEqual([
			'2026-10-26T14:00',
			'2026-11-02T15:00',
			'2026-11-09T15:00'
		]);
	});

	test('weekdays, every other week, and counts', () => {
		expect(expand('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=5', '2026-11-12T08:00', '2026-11-01T00:00Z', '2026-12-01T00:00Z')).toEqual([
			'2026-11-12T14:00',
			'2026-11-13T14:00',
			'2026-11-16T14:00',
			'2026-11-17T14:00',
			'2026-11-18T14:00'
		]);
		expect(expand('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH', '2026-11-10T10:00', '2026-11-01T00:00Z', '2026-12-01T00:00Z')).toEqual([
			'2026-11-10T16:00',
			'2026-11-12T16:00',
			'2026-11-24T16:00',
			'2026-11-26T16:00'
		]);
	});

	test('monthly by weekday, last weekday, and days that some months lack', () => {
		expect(expand('FREQ=MONTHLY;BYDAY=2TU', '2026-01-13T10:00', '2026-01-01T00:00Z', '2026-04-01T00:00Z')).toEqual([
			'2026-01-13T16:00',
			'2026-02-10T16:00',
			'2026-03-10T15:00'
		]);
		expect(expand('FREQ=MONTHLY;BYDAY=-1FR', '2026-01-30T16:00', '2026-01-01T00:00Z', '2026-04-01T00:00Z')).toEqual([
			'2026-01-30T22:00',
			'2026-02-27T22:00',
			'2026-03-27T21:00'
		]);
		// The 31st skips months without one, as RFC 5545 says.
		expect(expand('FREQ=MONTHLY', '2026-01-31T09:00', '2026-01-01T00:00Z', '2026-06-01T00:00Z')).toEqual([
			'2026-01-31T15:00',
			'2026-03-31T14:00',
			'2026-05-31T14:00'
		]);
		// Last weekday of the month.
		expect(expand('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', '2026-01-30T09:00', '2026-01-01T00:00Z', '2026-06-01T00:00Z')).toEqual([
			'2026-01-30T15:00',
			'2026-02-27T15:00',
			'2026-03-31T14:00',
			'2026-04-30T14:00',
			'2026-05-29T14:00'
		]);
	});

	test('yearly, until, skipped dates, and old series stay fast', () => {
		expect(expand('FREQ=YEARLY', '2024-02-29T09:00', '2024-01-01T00:00Z', '2029-01-01T00:00Z')).toEqual([
			'2024-02-29T15:00',
			'2028-02-29T15:00'
		]);
		expect(expand('FREQ=DAILY;UNTIL=20261112T235959Z', '2026-11-10T09:00', '2026-11-01T00:00Z', '2026-12-01T00:00Z')).toHaveLength(3);
		expect(
			expand('FREQ=DAILY;COUNT=4', '2026-11-10T09:00', '2026-11-01T00:00Z', '2026-12-01T00:00Z', CHICAGO, new Set(['2026-11-11T09:00']))
		).toEqual(['2026-11-10T15:00', '2026-11-12T15:00', '2026-11-13T15:00']);
		const began = performance.now();
		expect(expand('FREQ=DAILY', '2010-01-01T09:00', '2026-11-10T00:00Z', '2026-11-12T00:00Z')).toHaveLength(2);
		expect(performance.now() - began).toBeLessThan(500);
	});

	test('reading, writing, and describing rules', () => {
		expect(formatRule(parseRule('RRULE:freq=weekly;byday=mo,we;interval=2'))).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE');
		expect(describeRule(parseRule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'))).toBe('Every weekday');
		expect(describeRule(parseRule('FREQ=MONTHLY;BYDAY=-1FR;COUNT=3'))).toBe('Every month on the last Fri, 3 times');
		for (const bad of ['', 'FREQ=HOURLY', 'FREQ=DAILY;INTERVAL=0', 'FREQ=WEEKLY;BYDAY=XX', 'FREQ=MONTHLY;BYMONTHDAY=32', 'nonsense']) {
			expect(() => parseRule(bad)).toThrow(RuleError);
		}
	});
});

describe('iCalendar output', () => {
	test('escaping and folding long lines', () => {
		expect(escapeText('Lunch; with Pat, Lee\nand C:\\temp')).toBe('Lunch\\; with Pat\\, Lee\\nand C:\\\\temp');
		const folded = foldLine(`DESCRIPTION:${'é'.repeat(60)}`);
		for (const line of folded.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
		expect(folded.replace(/\r\n /g, '')).toBe(`DESCRIPTION:${'é'.repeat(60)}`);
	});

	test('a repeating event with a skipped date and an edited occurrence', () => {
		const base = {
			uid: 'abc@mail.test',
			sequence: 2,
			title: 'Standup',
			description: null,
			location: 'Room 1',
			allDay: false,
			startLocal: '2026-11-10T09:00',
			endLocal: '2026-11-10T09:15',
			timezone: CHICAGO,
			rrule: 'FREQ=WEEKLY;BYDAY=TU',
			exdates: ['2026-11-24T09:00'],
			recurrenceLocal: null,
			transparency: 'busy' as const,
			status: 'confirmed' as const,
			updatedAt: '2026-11-10T12:00:00.000Z'
		};
		const file = calendarFile({
			name: 'Work',
			timezone: CHICAGO,
			events: [base, { ...base, rrule: null, exdates: [], recurrenceLocal: '2026-11-17T09:00', startLocal: '2026-11-17T10:00', endLocal: '2026-11-17T10:15' }]
		});
		expect(file).toContain('DTSTART;TZID=America/Chicago:20261110T090000\r\n');
		expect(file).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU\r\n');
		expect(file).toContain('EXDATE;TZID=America/Chicago:20261124T090000\r\n');
		expect(file).toContain('RECURRENCE-ID;TZID=America/Chicago:20261117T090000\r\n');
		expect(file.endsWith('END:VCALENDAR\r\n')).toBe(true);
	});
});

describe('calendars and events', () => {
	async function setup() {
		const { sqlite, db } = open();
		const [calendar] = await ensureCalendars(db, 'u1', { name: 'Sada', timezone: CHICAGO });
		return { sqlite, db, calendar };
	}
	const week = (db: D1Database, calendar: { id: string } & Parameters<typeof occurrencesInRange>[1][number]) =>
		occurrencesInRange(db, [calendar], at('2026-11-09T00:00Z'), at('2026-11-30T00:00Z'));

	test('the first visit makes a calendar in your zone, once', async () => {
		const { db, calendar } = await setup();
		expect(calendar).toMatchObject({ name: 'Sada', timezone: CHICAGO, isDefault: true });
		expect(await ensureCalendars(db, 'u1', { name: 'Other', timezone: 'UTC' })).toHaveLength(1);
	});

	test('one-off, all-day, and repeating events in a range', async () => {
		const { db, calendar } = await setup();
		await createEvent(db, 'u1', { calendarId: calendar.id, title: 'Call with Pat', start: '2026-11-10T09:00', end: '2026-11-10T09:30' });
		await createEvent(db, 'u1', { calendarId: calendar.id, title: 'Offsite', allDay: true, start: '2026-11-12', end: '2026-11-14' });
		await createEvent(db, 'u1', {
			calendarId: calendar.id,
			title: 'Standup',
			start: '2026-11-10T08:45',
			end: '2026-11-10T09:00',
			rrule: 'FREQ=WEEKLY;BYDAY=TU;COUNT=3'
		});
		const list = await week(db, calendar);
		expect(list.map((item) => [item.title, item.startLocal])).toEqual([
			['Standup', '2026-11-10T08:45'],
			['Call with Pat', '2026-11-10T09:00'],
			['Offsite', '2026-11-12'],
			['Standup', '2026-11-17T08:45'],
			['Standup', '2026-11-24T08:45']
		]);
		const offsite = list.find((item) => item.title === 'Offsite')!;
		expect(offsite).toMatchObject({ allDay: true, endLocal: '2026-11-14', start: '2026-11-12T06:00:00.000Z' });
	});

	test('edit or delete just one occurrence, then the whole series', async () => {
		const { db, calendar } = await setup();
		const id = await createEvent(db, 'u1', {
			calendarId: calendar.id,
			title: 'Standup',
			start: '2026-11-10T08:45',
			end: '2026-11-10T09:00',
			rrule: 'FREQ=WEEKLY;BYDAY=TU'
		});
		// Move just the 17th to 10:00 and rename it.
		const editId = await updateEvent(db, 'u1', id, {
			occurrence: '2026-11-17T08:45',
			title: 'Standup (late)',
			start: '2026-11-17T10:00',
			end: '2026-11-17T10:15'
		});
		// Skip the 24th.
		await deleteEvent(db, 'u1', id, '2026-11-24T08:45');
		let list = await week(db, calendar);
		expect(list.map((item) => [item.title, item.startLocal])).toEqual([
			['Standup', '2026-11-10T08:45'],
			['Standup (late)', '2026-11-17T10:00']
		]);
		expect(list[1]).toMatchObject({ eventId: editId, seriesId: id, occurrence: '2026-11-17T08:45', recurring: true });

		// Editing the edited copy again updates it, not a second copy.
		await updateEvent(db, 'u1', id, { occurrence: '2026-11-17T08:45', title: 'Standup (moved)' });
		list = await week(db, calendar);
		expect(list.map((item) => item.title)).toEqual(['Standup', 'Standup (moved)']);

		// A made-up occurrence is refused.
		await expect(updateEvent(db, 'u1', id, { occurrence: '2026-11-18T08:45', title: 'x' })).rejects.toThrow('occurrence');

		// Renaming the series keeps one-off edits; moving its time resets them.
		await updateEvent(db, 'u1', id, { title: 'Team standup' });
		list = await week(db, calendar);
		expect(list.map((item) => item.title)).toEqual(['Team standup', 'Standup (moved)']);
		await updateEvent(db, 'u1', id, { start: '2026-11-10T08:30', end: '2026-11-10T08:45' });
		list = await week(db, calendar);
		expect(list.map((item) => item.startLocal)).toEqual(['2026-11-10T08:30', '2026-11-17T08:30', '2026-11-24T08:30']);

		await deleteEvent(db, 'u1', id);
		expect(await week(db, calendar)).toEqual([]);
	});

	test("bad input is refused, and you can't touch someone else's calendar", async () => {
		const { sqlite, db, calendar } = await setup();
		const base = { calendarId: calendar.id, title: 'x', start: '2026-11-10T09:00', end: '2026-11-10T10:00' };
		for (const [change, code] of [
			[{ title: '' }, 'title'],
			[{ end: '2026-11-10T08:00' }, 'time'],
			[{ start: '2026-11-10 09:00' }, 'time'],
			[{ timezone: 'Mars/Olympus' }, 'timezone'],
			[{ rrule: 'FREQ=SECONDLY' }, 'rrule'],
			[{ calendarId: 'nope' }, 'calendar']
		] as const) {
			await expect(createEvent(db, 'u1', { ...base, ...change })).rejects.toMatchObject({ code });
		}
		addUser(sqlite, 'u2', 'Lee', ['lee@acme.com']);
		const id = await createEvent(db, 'u1', base);
		await expect(updateEvent(db, 'u2', id, { title: 'mine now' })).rejects.toBeInstanceOf(CalendarError);
		await expect(deleteEvent(db, 'u2', id)).rejects.toBeInstanceOf(CalendarError);
		await expect(createEvent(db, 'u2', base)).rejects.toMatchObject({ code: 'calendar' });
	});

	test('the subscribe link opens only with its token, and replacing it turns the old one off', async () => {
		const { db, calendar } = await setup();
		const first = await rotateFeedToken(db, 'u1', calendar.id);
		expect((await calendarForFeedToken(db, first))?.id).toBe(calendar.id);
		const second = await rotateFeedToken(db, 'u1', calendar.id);
		expect(await calendarForFeedToken(db, first)).toBeNull();
		expect((await calendarForFeedToken(db, second))?.id).toBe(calendar.id);
		expect(await calendarForFeedToken(db, 'short')).toBeNull();
	});
});

describe('repeat menu', () => {
	const tuesday = { year: 2026, month: 11, day: 24 };

	test('labels follow the start date', () => {
		const labels = presetLabels(tuesday).map((item) => item.label);
		expect(labels).toContain('Every week on Tuesday');
		expect(labels).toContain('Every month on the last Tuesday');
		expect(labels).toContain('Every year on November 24');
	});

	test('presets round-trip through RRULE text, with endings', () => {
		for (const preset of ['daily', 'weekly', 'weekdays', 'monthly_day', 'monthly_weekday', 'yearly'] as const) {
			const text = ruleFor(preset, tuesday, { kind: 'after', count: 5 }, CHICAGO)!;
			expect(presetOf(text, tuesday, CHICAGO)).toEqual({ preset, end: { kind: 'after', count: 5 } });
		}
		const until = ruleFor('weekly', tuesday, { kind: 'on', date: { year: 2027, month: 1, day: 31 } }, CHICAGO)!;
		expect(presetOf(until, tuesday, CHICAGO).end).toEqual({ kind: 'on', date: { year: 2027, month: 1, day: 31 } });
		expect(ruleFor('none', tuesday, { kind: 'never' }, CHICAGO)).toBeNull();
		// Anything else shows as Custom and is kept as it was.
		expect(presetOf('FREQ=WEEKLY;INTERVAL=3;BYDAY=MO', tuesday, CHICAGO).preset).toBe('custom');
		expect(ruleFor('custom', tuesday, { kind: 'never' }, CHICAGO, 'FREQ=WEEKLY;INTERVAL=3')).toBe('FREQ=WEEKLY;INTERVAL=3');
	});
});
