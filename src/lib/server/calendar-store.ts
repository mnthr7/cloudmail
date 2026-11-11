import type { D1Database } from '@cloudflare/workers-types';
import {
	expandRule,
	keyOf,
	parseRule,
	RuleError,
	type Rule
} from '#lib/calendar/recurrence.ts';
import {
	addDays,
	daysBetween,
	formatDate,
	formatLocal,
	isTimeZone,
	localToUtc,
	utcToLocal,
	parseDate,
	parseLocal,
	type LocalDateTime
} from '#lib/calendar/time.ts';
import { CALENDAR_COLORS, type CalendarColor, type CalendarInfo, type Occurrence } from '#lib/calendar/types.ts';
import { humanPrincipalForUser } from './agents-store.ts';

/**
 * Native calendars and events (step 1). Each person has calendars they own;
 * events are stored once (a series) and expanded into occurrences for the
 * range being shown. Editing "just this one" stores an edited copy that
 * replaces that occurrence; deleting one adds it to the series' skip list.
 */

export class CalendarError extends Error {
	readonly status: number;

	constructor(
		readonly code:
			| 'calendar'
			| 'title'
			| 'time'
			| 'timezone'
			| 'rrule'
			| 'occurrence'
			| 'missing'
			| 'text'
			| 'color'
			| 'range'
			| 'guests'
			| 'from'
			| 'conflict'
			| 'source'
			| 'limit'
			| 'key'
	) {
		super(code);
		this.name = 'CalendarError';
		this.status = code === 'missing' ? 404 : 400;
	}
}

const MAX_TITLE = 200;
const MAX_LOCATION = 500;
const MAX_DESCRIPTION = 10_000;
/** The widest range one request may ask for. */
const MAX_RANGE_MS = 120 * 86_400_000;
/** Most rows one outside calendar's copy may hold. */
const MAX_COPIED_ROWS = 2_500;

type CalendarRow = {
	id: string;
	workspace_id: string;
	owner_principal_id: string;
	name: string;
	color: string;
	timezone: string;
	is_default: number;
	feed_token_hash: string | null;
	source_url_sealed?: string | null;
	source_host?: string | null;
	source_details?: number | null;
	source_synced_at?: string | null;
	source_error?: string | null;
};

function toInfo(row: CalendarRow): CalendarInfo {
	return {
		id: row.id,
		name: row.name,
		color: (CALENDAR_COLORS as readonly string[]).includes(row.color) ? (row.color as CalendarColor) : 'blue',
		timezone: row.timezone,
		isDefault: row.is_default === 1,
		hasFeed: row.feed_token_hash !== null,
		source: row.source_url_sealed
			? {
					host: row.source_host ?? '',
					details: row.source_details === 1,
					syncedAt: row.source_synced_at ?? null,
					error: row.source_error ?? null
				}
			: null
	};
}

export async function listCalendars(db: D1Database, userId: string): Promise<CalendarInfo[]> {
	const human = await humanPrincipalForUser(db, userId);
	const { results } = await db
		.prepare(`SELECT * FROM calendars WHERE owner_principal_id = ? ORDER BY is_default DESC, created_at ASC`)
		.bind(human.id)
		.all<CalendarRow>();
	return results.map(toInfo);
}

/** The person's calendars, making their first one if they have none. */
export async function ensureCalendars(
	db: D1Database,
	userId: string,
	defaults: { name: string; timezone: string },
	now = new Date()
): Promise<CalendarInfo[]> {
	const existing = await listCalendars(db, userId);
	// Outside calendars are copies; everyone still gets a calendar of their own.
	if (existing.some((calendar) => !calendar.source)) return existing;
	try {
		await createCalendar(db, userId, { ...defaults, timezone: isTimeZone(defaults.timezone) ? defaults.timezone : 'UTC', isDefault: true }, now);
	} catch (error) {
		// Another request made it first (one default per person); use theirs.
		if (!(error instanceof Error && /UNIQUE/i.test(error.message))) throw error;
	}
	return listCalendars(db, userId);
}

export async function createCalendar(
	db: D1Database,
	userId: string,
	input: { name: unknown; timezone: unknown; color?: unknown; isDefault?: boolean },
	now = new Date()
): Promise<CalendarInfo> {
	const human = await humanPrincipalForUser(db, userId);
	const name = typeof input.name === 'string' ? input.name.trim().slice(0, 80) : '';
	if (!name) throw new CalendarError('text');
	if (!isTimeZone(input.timezone)) throw new CalendarError('timezone');
	const color = input.color ?? 'blue';
	if (!(CALENDAR_COLORS as readonly unknown[]).includes(color)) throw new CalendarError('color');
	const id = crypto.randomUUID();
	const at = now.toISOString();
	await db
		.prepare(
			`INSERT INTO calendars (id, workspace_id, owner_principal_id, name, color, timezone, is_default, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(id, human.workspace_id, human.id, name, color, input.timezone, input.isDefault ? 1 : 0, at, at)
		.run();
	return toInfo({
		id,
		workspace_id: human.workspace_id,
		owner_principal_id: human.id,
		name,
		color: color as string,
		timezone: input.timezone as string,
		is_default: input.isDefault ? 1 : 0,
		feed_token_hash: null,
		source_url_sealed: null
	});
}

export async function updateCalendar(
	db: D1Database,
	userId: string,
	calendarId: string,
	input: { name?: unknown; color?: unknown; timezone?: unknown },
	now = new Date()
): Promise<void> {
	const calendar = await ownedCalendar(db, userId, calendarId);
	const name = input.name === undefined ? calendar.name : typeof input.name === 'string' ? input.name.trim().slice(0, 80) : '';
	if (!name) throw new CalendarError('text');
	const color = input.color ?? calendar.color;
	if (!(CALENDAR_COLORS as readonly unknown[]).includes(color)) throw new CalendarError('color');
	const timezone = input.timezone ?? calendar.timezone;
	if (!isTimeZone(timezone)) throw new CalendarError('timezone');
	await db
		.prepare(`UPDATE calendars SET name = ?, color = ?, timezone = ?, updated_at = ? WHERE id = ?`)
		.bind(name, color, timezone, now.toISOString(), calendar.id)
		.run();
}

async function ownedCalendar(db: D1Database, userId: string, calendarId: string): Promise<CalendarRow> {
	const human = await humanPrincipalForUser(db, userId);
	const row = await db
		.prepare(`SELECT * FROM calendars WHERE id = ? AND owner_principal_id = ?`)
		.bind(calendarId, human.id)
		.first<CalendarRow>();
	if (!row) throw new CalendarError('calendar');
	return row;
}

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * A new secret subscribe link for a calendar. Only its hash is stored, so the
 * token is shown once; making a new one turns the old link off.
 */
export async function rotateFeedToken(db: D1Database, userId: string, calendarId: string, now = new Date()): Promise<string> {
	const calendar = await ownedCalendar(db, userId, calendarId);
	// Someone else's calendar isn't yours to republish.
	if (calendar.source_url_sealed) throw new CalendarError('calendar');
	const bytes = crypto.getRandomValues(new Uint8Array(24));
	const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	await db
		.prepare(`UPDATE calendars SET feed_token_hash = ?, updated_at = ? WHERE id = ?`)
		.bind(await sha256(token), now.toISOString(), calendar.id)
		.run();
	return token;
}

export async function removeFeedToken(db: D1Database, userId: string, calendarId: string): Promise<void> {
	const calendar = await ownedCalendar(db, userId, calendarId);
	await db.prepare(`UPDATE calendars SET feed_token_hash = NULL WHERE id = ?`).bind(calendar.id).run();
}

/** The calendar a subscribe-link token opens, or null. */
export async function calendarForFeedToken(db: D1Database, token: string): Promise<CalendarInfo | null> {
	if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
	const row = await db
		.prepare(`SELECT * FROM calendars WHERE feed_token_hash = ? AND source_url_sealed IS NULL`)
		.bind(await sha256(token))
		.first<CalendarRow>();
	return row ? toInfo(row) : null;
}

// ---------------------------------------------------------------------------
// Events

export type EventRow = {
	id: string;
	calendar_id: string;
	uid: string;
	sequence: number;
	title: string;
	description: string | null;
	location: string | null;
	all_day: number;
	start_local: string;
	end_local: string;
	timezone: string;
	start_at: string;
	end_at: string;
	rrule: string | null;
	exdates_json: string;
	repeat_until_at: string | null;
	parent_id: string | null;
	recurrence_local: string | null;
	status: 'confirmed' | 'tentative' | 'cancelled';
	transparency: 'busy' | 'free';
	organizer_email: string | null;
	organizer_name: string | null;
	my_status: string | null;
	send_from: string | null;
	source_email_id: string | null;
	created_at: string;
	updated_at: string;
};

export type EventInput = {
	calendarId?: unknown;
	title?: unknown;
	description?: unknown;
	location?: unknown;
	allDay?: unknown;
	/** "2026-11-10T09:00", or "2026-11-10" for all-day. */
	start?: unknown;
	/** Exclusive end: "2026-11-10T10:00", or the day after the last day for all-day. */
	end?: unknown;
	timezone?: unknown;
	/** RRULE text, or null for a one-off. */
	rrule?: unknown;
	transparency?: unknown;
};

type Timing = {
	allDay: boolean;
	startLocal: string;
	endLocal: string;
	timezone: string;
	startAt: number;
	endAt: number;
};

/** Checks start, end and zone, and works out the UTC span. */
function readTiming(input: EventInput, fallback?: Timing): Timing {
	const allDay = input.allDay === undefined ? (fallback?.allDay ?? false) : input.allDay === true;
	const timezone = input.timezone ?? fallback?.timezone;
	if (!isTimeZone(timezone)) throw new CalendarError('timezone');
	const startText = input.start ?? fallback?.startLocal;
	const endText = input.end ?? fallback?.endLocal;
	if (allDay) {
		const start = parseDate(startText);
		const end = parseDate(endText);
		if (!start || !end || daysBetween(start, end) < 1 || daysBetween(start, end) > 366) throw new CalendarError('time');
		return {
			allDay,
			startLocal: startText as string,
			endLocal: endText as string,
			timezone,
			startAt: localToUtc({ ...start, hour: 0, minute: 0 }, timezone),
			endAt: localToUtc({ ...end, hour: 0, minute: 0 }, timezone)
		};
	}
	const start = parseLocal(startText);
	const end = parseLocal(endText);
	if (!start || !end) throw new CalendarError('time');
	const startAt = localToUtc(start, timezone);
	const endAt = localToUtc(end, timezone);
	if (endAt <= startAt || endAt - startAt > 14 * 86_400_000) throw new CalendarError('time');
	return { allDay, startLocal: startText as string, endLocal: endText as string, timezone, startAt, endAt };
}

function readText(value: unknown, max: number, required = false): string | null {
	if (value === undefined || value === null || value === '') {
		if (required) throw new CalendarError('title');
		return null;
	}
	if (typeof value !== 'string') throw new CalendarError('text');
	const text = value.trim();
	if (required && !text) throw new CalendarError('title');
	if (text.length > max) throw new CalendarError(required ? 'title' : 'text');
	return text || null;
}

function readRule(value: unknown, timezone: string): { text: string | null; rule: Rule | null } {
	if (value === undefined || value === null || value === '') return { text: null, rule: null };
	if (typeof value !== 'string') throw new CalendarError('rrule');
	try {
		const rule = parseRule(value, timezone);
		return { text: value.trim().replace(/^RRULE:/i, '').toUpperCase(), rule };
	} catch (error) {
		if (error instanceof RuleError) throw new CalendarError('rrule');
		throw error;
	}
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

/** Writable calendars: the person's own, not copies of outside ones. */
async function writableCalendarIds(db: D1Database, userId: string): Promise<Set<string>> {
	return new Set(
		(await listCalendars(db, userId)).filter((calendar) => !calendar.source).map((calendar) => calendar.id)
	);
}

export async function createEvent(
	db: D1Database,
	userId: string,
	input: EventInput,
	options: { now?: Date; uidDomain?: string } = {}
): Promise<string> {
	const now = options.now ?? new Date();
	const calendarId = typeof input.calendarId === 'string' ? input.calendarId : '';
	const calendar = await ownedCalendar(db, userId, calendarId);
	// Outside calendars are read-only copies.
	if (calendar.source_url_sealed) throw new CalendarError('calendar');
	const timing = readTiming({ ...input, timezone: input.timezone ?? calendar.timezone });
	const repeat = readRule(input.rrule, timing.timezone);
	const human = await humanPrincipalForUser(db, userId);
	const id = crypto.randomUUID();
	const uid = `${id}@${options.uidDomain ?? 'cloudmail'}`;
	const at = now.toISOString();
	await db
		.prepare(
			`INSERT INTO calendar_events
			 (id, calendar_id, uid, sequence, title, description, location, all_day, start_local, end_local, timezone,
			  start_at, end_at, rrule, exdates_json, repeat_until_at, transparency, created_by_principal_id, created_at, updated_at)
			 VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?)`
		)
		.bind(
			id,
			calendar.id,
			uid,
			readText(input.title, MAX_TITLE, true),
			readText(input.description, MAX_DESCRIPTION),
			readText(input.location, MAX_LOCATION),
			timing.allDay ? 1 : 0,
			timing.startLocal,
			timing.endLocal,
			timing.timezone,
			iso(timing.startAt),
			iso(timing.endAt),
			repeat.text,
			repeat.rule?.until !== undefined ? iso(repeat.rule.until) : null,
			input.transparency === 'free' ? 'free' : 'busy',
			human.id,
			at,
			at
		)
		.run();
	return id;
}

async function ownedEvent(db: D1Database, userId: string, eventId: string): Promise<EventRow> {
	const writable = await writableCalendarIds(db, userId);
	const row = await db.prepare(`SELECT * FROM calendar_events WHERE id = ?`).bind(eventId).first<EventRow>();
	if (!row || !writable.has(row.calendar_id)) throw new CalendarError('missing');
	return row;
}

function timingOf(row: EventRow): Timing {
	return {
		allDay: row.all_day === 1,
		startLocal: row.start_local,
		endLocal: row.end_local,
		timezone: row.timezone,
		startAt: Date.parse(row.start_at),
		endAt: Date.parse(row.end_at)
	};
}

function exdates(row: EventRow): string[] {
	try {
		const value = JSON.parse(row.exdates_json) as unknown;
		return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
	} catch {
		return [];
	}
}

/** Checks `occurrence` is a real occurrence key of this series. */
function assertOccurrence(series: EventRow, occurrence: unknown): string {
	if (typeof occurrence !== 'string' || !series.rrule) throw new CalendarError('occurrence');
	const allDay = series.all_day === 1;
	const local: LocalDateTime | null = allDay
		? (() => {
				const date = parseDate(occurrence.slice(0, 10));
				return date ? { ...date, hour: 0, minute: 0 } : null;
			})()
		: parseLocal(occurrence);
	if (!local) throw new CalendarError('occurrence');
	const at = localToUtc(local, series.timezone);
	const start = seriesStart(series);
	const found = expandRule({
		rule: parseRule(series.rrule, series.timezone),
		start,
		timeZone: series.timezone,
		durationMs: 1,
		rangeStart: at,
		rangeEnd: at + 1
	});
	if (!found.some((item) => item.start === at)) throw new CalendarError('occurrence');
	return keyOf(local);
}

function seriesStart(row: EventRow): LocalDateTime {
	if (row.all_day === 1) {
		const date = parseDate(row.start_local)!;
		return { ...date, hour: 0, minute: 0 };
	}
	return parseLocal(row.start_local)!;
}

/**
 * Edits an event. For a repeating series, `occurrence` (its wall-clock start
 * key) edits just that one, leaving the rest of the series alone.
 */
export async function updateEvent(
	db: D1Database,
	userId: string,
	eventId: string,
	input: EventInput & { occurrence?: unknown },
	now = new Date()
): Promise<string> {
	const row = await ownedEvent(db, userId, eventId);
	const at = now.toISOString();

	if (input.occurrence !== undefined && row.parent_id === null && row.rrule) {
		// Just this one: store or update an edited copy that replaces it.
		const key = assertOccurrence(row, input.occurrence);
		const existing = await db
			.prepare(`SELECT * FROM calendar_events WHERE parent_id = ? AND recurrence_local = ?`)
			.bind(row.id, key)
			.first<EventRow>();
		if (existing) return updateEvent(db, userId, existing.id, { ...input, occurrence: undefined }, now);
		const base = occurrenceTiming(row, key);
		const timing = readTiming(input, base);
		const id = crypto.randomUUID();
		await db
			.prepare(
				`INSERT INTO calendar_events
				 (id, calendar_id, uid, sequence, title, description, location, all_day, start_local, end_local, timezone,
				  start_at, end_at, rrule, exdates_json, parent_id, recurrence_local, transparency, created_by_principal_id,
				  created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '[]', ?, ?, ?, (SELECT id FROM principals WHERE user_id = ?), ?, ?)`
			)
			.bind(
				id,
				row.calendar_id,
				row.uid,
				row.sequence + 1,
				input.title === undefined ? row.title : readText(input.title, MAX_TITLE, true),
				input.description === undefined ? row.description : readText(input.description, MAX_DESCRIPTION),
				input.location === undefined ? row.location : readText(input.location, MAX_LOCATION),
				timing.allDay ? 1 : 0,
				timing.startLocal,
				timing.endLocal,
				timing.timezone,
				iso(timing.startAt),
				iso(timing.endAt),
				row.id,
				key,
				input.transparency === undefined ? row.transparency : input.transparency === 'free' ? 'free' : 'busy',
				userId,
				at,
				at
			)
			.run();
		return id;
	}

	// The whole event (or the whole series, or one already-edited occurrence).
	const timing = readTiming(input, timingOf(row));
	const repeat =
		row.parent_id !== null
			? { text: null, rule: null }
			: input.rrule === undefined
				? readRule(row.rrule, timing.timezone)
				: readRule(input.rrule, timing.timezone);
	const statements = [
		db
			.prepare(
				`UPDATE calendar_events
				 SET title = ?, description = ?, location = ?, all_day = ?, start_local = ?, end_local = ?, timezone = ?,
				     start_at = ?, end_at = ?, rrule = ?, repeat_until_at = ?, transparency = ?, sequence = sequence + 1,
				     updated_at = ?
				 WHERE id = ?`
			)
			.bind(
				input.title === undefined ? row.title : readText(input.title, MAX_TITLE, true),
				input.description === undefined ? row.description : readText(input.description, MAX_DESCRIPTION),
				input.location === undefined ? row.location : readText(input.location, MAX_LOCATION),
				timing.allDay ? 1 : 0,
				timing.startLocal,
				timing.endLocal,
				timing.timezone,
				iso(timing.startAt),
				iso(timing.endAt),
				repeat.text,
				repeat.rule?.until !== undefined ? iso(repeat.rule.until) : null,
				input.transparency === undefined ? row.transparency : input.transparency === 'free' ? 'free' : 'busy',
				at,
				row.id
			)
	];
	// Moving a series' time or changing how it repeats makes earlier per-occurrence edits meaningless.
	const reshaped =
		row.parent_id === null &&
		row.rrule !== null &&
		(timing.startLocal !== row.start_local || timing.timezone !== row.timezone || repeat.text !== row.rrule);
	if (reshaped) {
		statements.push(db.prepare(`DELETE FROM calendar_events WHERE parent_id = ?`).bind(row.id));
		statements.push(db.prepare(`UPDATE calendar_events SET exdates_json = '[]' WHERE id = ?`).bind(row.id));
	}
	await db.batch(statements);
	return row.id;
}

/** Where one occurrence of a series falls, to start an edited copy from. */
function occurrenceTiming(series: EventRow, key: string): Timing {
	const base = timingOf(series);
	if (series.all_day === 1) {
		const seriesStartDate = parseDate(series.start_local)!;
		const length = daysBetween(seriesStartDate, parseDate(series.end_local)!);
		const start = parseDate(key.slice(0, 10))!;
		const end = addDays(start, length);
		return {
			...base,
			startLocal: formatDate(start),
			endLocal: formatDate(end),
			startAt: localToUtc({ ...start, hour: 0, minute: 0 }, series.timezone),
			endAt: localToUtc({ ...end, hour: 0, minute: 0 }, series.timezone)
		};
	}
	const start = parseLocal(key)!;
	const startAt = localToUtc(start, series.timezone);
	// The edited copy keeps the series' length; its end is written on the zone's wall clock.
	const endAt = startAt + (base.endAt - base.startAt);
	return { ...base, startLocal: key, endLocal: toLocalText(endAt, series.timezone), startAt, endAt };
}

function toLocalText(ms: number, timeZone: string): string {
	return formatLocal(utcToLocal(ms, timeZone));
}

/**
 * Deletes an event. For a series, `occurrence` removes just that one (it's
 * added to the series' skip list, and any edited copy of it goes too).
 */
export async function deleteEvent(
	db: D1Database,
	userId: string,
	eventId: string,
	occurrence?: unknown,
	now = new Date()
): Promise<void> {
	const row = await ownedEvent(db, userId, eventId);
	if (occurrence !== undefined && row.parent_id === null && row.rrule) {
		const key = assertOccurrence(row, occurrence);
		const skip = [...new Set([...exdates(row), key])];
		await db.batch([
			db
				.prepare(`UPDATE calendar_events SET exdates_json = ?, sequence = sequence + 1, updated_at = ? WHERE id = ?`)
				.bind(JSON.stringify(skip), now.toISOString(), row.id),
			db.prepare(`DELETE FROM calendar_events WHERE parent_id = ? AND recurrence_local = ?`).bind(row.id, key)
		]);
		return;
	}
	if (row.parent_id !== null && row.recurrence_local) {
		// An edited occurrence: removing it removes that occurrence from the series.
		const series = await db.prepare(`SELECT * FROM calendar_events WHERE id = ?`).bind(row.parent_id).first<EventRow>();
		const statements = [db.prepare(`DELETE FROM calendar_events WHERE id = ?`).bind(row.id)];
		if (series) {
			const skip = [...new Set([...exdates(series), row.recurrence_local])];
			statements.push(
				db
					.prepare(`UPDATE calendar_events SET exdates_json = ?, sequence = sequence + 1, updated_at = ? WHERE id = ?`)
					.bind(JSON.stringify(skip), now.toISOString(), series.id)
			);
		}
		await db.batch(statements);
		return;
	}
	await db.prepare(`DELETE FROM calendar_events WHERE id = ?`).bind(row.id).run();
}

// ---------------------------------------------------------------------------
// Reading a range

/** Every occurrence on the given calendars between two UTC instants, sorted by start. */
export async function occurrencesInRange(
	db: D1Database,
	calendars: CalendarInfo[],
	rangeStart: number,
	rangeEnd: number
): Promise<Occurrence[]> {
	if (!(rangeEnd > rangeStart) || rangeEnd - rangeStart > MAX_RANGE_MS) throw new CalendarError('range');
	if (calendars.length === 0) return [];
	const byId = new Map(calendars.map((calendar) => [calendar.id, calendar]));
	const ids = JSON.stringify(calendars.map((calendar) => calendar.id));
	const startIso = iso(rangeStart);
	const endIso = iso(rangeEnd);
	const { results } = await db
		.prepare(
			`SELECT * FROM calendar_events
			 WHERE calendar_id IN (SELECT value FROM json_each(?)) AND status <> 'cancelled'
			   AND (
			     (rrule IS NULL AND start_at < ? AND end_at > ?)
			     OR (rrule IS NOT NULL AND parent_id IS NULL AND start_at < ? AND (repeat_until_at IS NULL OR repeat_until_at >= ?))
			   )`
		)
		.bind(ids, endIso, startIso, endIso, startIso)
		.all<EventRow>();

	// Edited copies replace their occurrence in the series, wherever they moved to.
	const seriesIds = results.filter((row) => row.rrule && !row.parent_id).map((row) => row.id);
	const replaced = new Map<string, Set<string>>();
	if (seriesIds.length) {
		const edits = await db
			.prepare(`SELECT parent_id, recurrence_local FROM calendar_events WHERE parent_id IN (SELECT value FROM json_each(?))`)
			.bind(JSON.stringify(seriesIds))
			.all<{ parent_id: string; recurrence_local: string }>();
		for (const edit of edits.results) {
			const set = replaced.get(edit.parent_id) ?? new Set<string>();
			set.add(edit.recurrence_local);
			replaced.set(edit.parent_id, set);
		}
	}

	const out: Occurrence[] = [];
	for (const row of results) {
		const calendar = byId.get(row.calendar_id);
		if (!calendar) continue;
		const base = {
			eventId: row.id,
			seriesId: row.parent_id ?? row.id,
			calendarId: row.calendar_id,
			color: calendar.color,
			title: row.title,
			description: row.description,
			location: row.location,
			allDay: row.all_day === 1,
			timezone: row.timezone,
			rrule: row.rrule,
			seriesStartLocal: row.start_local,
			transparency: row.transparency,
			organizer: row.organizer_email ? { email: row.organizer_email, name: row.organizer_name } : null,
			myStatus: row.my_status,
			sourceEmailId: row.source_email_id
		};
		if (!row.rrule) {
			out.push({
				...base,
				occurrence: row.recurrence_local,
				recurring: row.parent_id !== null,
				start: row.start_at,
				end: row.end_at,
				startLocal: row.start_local,
				endLocal: row.end_local
			});
			continue;
		}
		const timing = timingOf(row);
		const duration = timing.endAt - timing.startAt;
		const allDayLength = row.all_day === 1 ? daysBetween(parseDate(row.start_local)!, parseDate(row.end_local)!) : 0;
		const skip = new Set([...exdates(row), ...(replaced.get(row.id) ?? [])]);
		let occurrences;
		try {
			occurrences = expandRule({
				rule: parseRule(row.rrule, row.timezone),
				start: seriesStart(row),
				timeZone: row.timezone,
				durationMs: duration,
				rangeStart,
				rangeEnd,
				excluded: skip,
				allDay: row.all_day === 1
			});
		} catch {
			continue;
		}
		for (const occurrence of occurrences) {
			const key = keyOf(occurrence.local);
			let end: number;
			let startLocal = key;
			let endLocal: string;
			if (row.all_day === 1) {
				const day = { year: occurrence.local.year, month: occurrence.local.month, day: occurrence.local.day };
				const last = addDays(day, allDayLength);
				end = localToUtc({ ...last, hour: 0, minute: 0 }, row.timezone);
				startLocal = key.slice(0, 10);
				endLocal = formatDate(last);
			} else {
				end = occurrence.start + duration;
				endLocal = toLocalText(end, row.timezone);
			}
			out.push({
				...base,
				occurrence: key,
				recurring: true,
				start: iso(occurrence.start),
				end: iso(end),
				startLocal,
				endLocal
			});
		}
	}
	out.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
	return out;
}

/** The series and its edited occurrences, for the subscribe feed. */
export async function eventsForFeed(db: D1Database, calendarId: string): Promise<EventRow[]> {
	const { results } = await db
		.prepare(`SELECT * FROM calendar_events WHERE calendar_id = ? AND status <> 'cancelled' ORDER BY start_at`)
		.bind(calendarId)
		.all<EventRow>();
	return results;
}

// ---------------------------------------------------------------------------
// Events that came from somewhere else (an invite you accepted)

export type ImportedEvent = {
	uid: string;
	sequence: number;
	title: string;
	description: string | null;
	location: string | null;
	allDay: boolean;
	startLocal: string;
	endLocal: string;
	timezone: string;
	rrule: string | null;
	exdates: string[];
	recurrenceLocal: string | null;
	transparency: 'busy' | 'free';
};

/** Checks an outside event's times and rule; null if it can't be stored as given. */
function importTiming(event: ImportedEvent): (Timing & { rrule: string | null; until: number | undefined }) | null {
	let timing: Timing;
	try {
		timing = readTiming({ allDay: event.allDay, start: event.startLocal, end: event.endLocal, timezone: event.timezone });
	} catch {
		return null;
	}
	let rrule: string | null = null;
	let until: number | undefined;
	if (event.rrule) {
		try {
			until = parseRule(event.rrule, event.timezone).until;
			rrule = event.rrule;
		} catch {
			// A rule we can't read: keep just the first occurrence.
		}
	}
	return { ...timing, rrule, until };
}

/**
 * Puts an outside event (series plus edited occurrences) on a calendar, or
 * updates the copy already there with the same UID. Returns the series row id.
 */
export async function upsertImportedEvent(
	db: D1Database,
	calendar: { id: string },
	input: {
		series: ImportedEvent;
		edits: ImportedEvent[];
		organizer: { email: string; name: string | null } | null;
		myStatus: string | null;
		sourceEmailId: string | null;
		createdBy: string | null;
	},
	now = new Date()
): Promise<string | null> {
	const timing = importTiming(input.series);
	if (!timing) return null;
	const at = now.toISOString();
	const existing = await db
		.prepare(`SELECT id, organizer_email FROM calendar_events WHERE calendar_id = ? AND uid = ? AND parent_id IS NULL`)
		.bind(calendar.id, input.series.uid)
		.first<{ id: string; organizer_email: string | null }>();
	// An outside event may only replace a copy of the same organizer's event: never one
	// of your own (no organizer), and never someone else's with a colliding UID.
	if (existing && (!existing.organizer_email || existing.organizer_email !== (input.organizer?.email ?? null))) {
		throw new CalendarError('conflict');
	}
	const id = existing?.id ?? crypto.randomUUID();
	const values = [
		input.series.sequence,
		input.series.title.slice(0, MAX_TITLE) || '(No title)',
		input.series.description?.slice(0, MAX_DESCRIPTION) ?? null,
		input.series.location?.slice(0, MAX_LOCATION) ?? null,
		timing.allDay ? 1 : 0,
		timing.startLocal,
		timing.endLocal,
		timing.timezone,
		iso(timing.startAt),
		iso(timing.endAt),
		timing.rrule,
		JSON.stringify(timing.rrule ? input.series.exdates.slice(0, 500) : []),
		timing.until !== undefined ? iso(timing.until) : null,
		input.series.transparency,
		input.organizer?.email ?? null,
		input.organizer?.name ?? null,
		input.myStatus,
		input.sourceEmailId
	];
	const statements = [
		existing
			? db
					.prepare(
						`UPDATE calendar_events
						 SET sequence = ?, title = ?, description = ?, location = ?, all_day = ?, start_local = ?, end_local = ?,
						     timezone = ?, start_at = ?, end_at = ?, rrule = ?, exdates_json = ?, repeat_until_at = ?, transparency = ?,
						     organizer_email = ?, organizer_name = ?, my_status = ?, source_email_id = COALESCE(?, source_email_id),
						     status = 'confirmed', updated_at = ?
						 WHERE id = ?`
					)
					.bind(...values, at, id)
			: db
					.prepare(
						`INSERT INTO calendar_events
						 (sequence, title, description, location, all_day, start_local, end_local, timezone, start_at, end_at, rrule,
						  exdates_json, repeat_until_at, transparency, organizer_email, organizer_name, my_status, source_email_id,
						  id, calendar_id, uid, created_by_principal_id, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
					)
					.bind(...values, id, calendar.id, input.series.uid, input.createdBy, at, at),
		// Edited occurrences are replaced wholesale by the newest copy.
		db.prepare(`DELETE FROM calendar_events WHERE parent_id = ?`).bind(id)
	];
	for (const edit of timing.rrule ? input.edits.slice(0, 200) : []) {
		const editTiming = importTiming({ ...edit, rrule: null });
		if (!editTiming || !edit.recurrenceLocal) continue;
		statements.push(
			db
				.prepare(
					`INSERT INTO calendar_events
					 (id, calendar_id, uid, sequence, title, description, location, all_day, start_local, end_local, timezone,
					  start_at, end_at, exdates_json, parent_id, recurrence_local, transparency, organizer_email, organizer_name,
					  my_status, source_email_id, created_by_principal_id, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(
					crypto.randomUUID(),
					calendar.id,
					input.series.uid,
					edit.sequence,
					edit.title.slice(0, MAX_TITLE) || '(No title)',
					edit.description?.slice(0, MAX_DESCRIPTION) ?? null,
					edit.location?.slice(0, MAX_LOCATION) ?? null,
					editTiming.allDay ? 1 : 0,
					editTiming.startLocal,
					editTiming.endLocal,
					editTiming.timezone,
					iso(editTiming.startAt),
					iso(editTiming.endAt),
					id,
					edit.recurrenceLocal,
					edit.transparency,
					input.organizer?.email ?? null,
					input.organizer?.name ?? null,
					input.myStatus,
					input.sourceEmailId,
					input.createdBy,
					at,
					at
				)
		);
	}
	await db.batch(statements);
	return id;
}

/**
 * Replaces everything on an outside calendar's copy with what its feed holds
 * now. Each group is a series (or one-off) and its edited occurrences.
 * `details` false keeps only the times, as "Busy". Returns how many were kept.
 */
export async function replaceCalendarEvents(
	db: D1Database,
	calendarId: string,
	groups: Array<{ series: ImportedEvent; edits: ImportedEvent[] }>,
	options: { details: boolean },
	now = new Date()
): Promise<number> {
	const at = now.toISOString();
	const statements = [db.prepare(`DELETE FROM calendar_events WHERE calendar_id = ?`).bind(calendarId)];
	const insert = (
		id: string,
		event: ImportedEvent,
		timing: Timing & { rrule: string | null; until: number | undefined },
		parentId: string | null
	) =>
		db
			.prepare(
				`INSERT INTO calendar_events
				 (id, calendar_id, uid, sequence, title, description, location, all_day, start_local, end_local, timezone,
				  start_at, end_at, rrule, exdates_json, repeat_until_at, parent_id, recurrence_local, transparency,
				  created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				id,
				calendarId,
				event.uid,
				event.sequence,
				options.details ? event.title.slice(0, MAX_TITLE) || '(No title)' : 'Busy',
				options.details ? (event.description?.slice(0, MAX_DESCRIPTION) ?? null) : null,
				options.details ? (event.location?.slice(0, MAX_LOCATION) ?? null) : null,
				timing.allDay ? 1 : 0,
				timing.startLocal,
				timing.endLocal,
				timing.timezone,
				iso(timing.startAt),
				iso(timing.endAt),
				parentId ? null : timing.rrule,
				JSON.stringify(!parentId && timing.rrule ? event.exdates.slice(0, 500) : []),
				!parentId && timing.until !== undefined ? iso(timing.until) : null,
				parentId,
				parentId ? event.recurrenceLocal : null,
				event.transparency,
				at,
				at
			);
	let kept = 0;
	const seen = new Set<string>();
	for (const group of groups) {
		// Rows written per refresh stay bounded, edits included.
		if (statements.length > MAX_COPIED_ROWS) break;
		if (seen.has(group.series.uid)) continue;
		const timing = importTiming(group.series);
		if (!timing) continue;
		seen.add(group.series.uid);
		const id = crypto.randomUUID();
		statements.push(insert(id, group.series, timing, null));
		kept++;
		const done = new Set<string>();
		for (const edit of timing.rrule ? group.edits.slice(0, 200) : []) {
			const editTiming = importTiming({ ...edit, rrule: null });
			if (!editTiming || !edit.recurrenceLocal || done.has(edit.recurrenceLocal)) continue;
			done.add(edit.recurrenceLocal);
			statements.push(insert(crypto.randomUUID(), edit, editTiming, id));
		}
	}
	// In slices, so a big calendar stays within what one batch may hold. The first
	// slice clears the old copy and starts the new one in a single transaction.
	for (let i = 0; i < statements.length; i += 100) {
		await db.batch(statements.slice(i, i + 100));
	}
	return kept;
}

/** The series row for an event row (itself, or the series an edited occurrence belongs to). */
export async function seriesOf(db: D1Database, userId: string, eventId: string): Promise<EventRow> {
	const row = await ownedEvent(db, userId, eventId);
	if (!row.parent_id) return row;
	const series = await db.prepare(`SELECT * FROM calendar_events WHERE id = ?`).bind(row.parent_id).first<EventRow>();
	if (!series) throw new CalendarError('missing');
	return series;
}

export async function editedOccurrences(db: D1Database, seriesId: string): Promise<EventRow[]> {
	const { results } = await db
		.prepare(`SELECT * FROM calendar_events WHERE parent_id = ? ORDER BY start_at`)
		.bind(seriesId)
		.all<EventRow>();
	return results;
}

/** The person's events with this UID (on any of their calendars). */
export async function eventsByUid(db: D1Database, userId: string, uid: string): Promise<EventRow[]> {
	const human = await humanPrincipalForUser(db, userId);
	const { results } = await db
		.prepare(
			`SELECT e.* FROM calendar_events e JOIN calendars c ON c.id = e.calendar_id
			 WHERE c.owner_principal_id = ? AND e.uid = ? AND e.parent_id IS NULL AND c.source_url_sealed IS NULL`
		)
		.bind(human.id, uid)
		.all<EventRow>();
	return results;
}

export async function setSendFrom(db: D1Database, eventId: string, address: string | null): Promise<void> {
	await db.prepare(`UPDATE calendar_events SET send_from = ? WHERE id = ?`).bind(address, eventId).run();
}
