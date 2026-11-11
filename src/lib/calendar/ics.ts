/**
 * iCalendar (RFC 5545) output: the subscribe feed now, invites later. Times
 * carry their IANA zone as TZID, which Google, Apple and Outlook all read, so
 * repeating events keep their wall-clock time on the phone too.
 */

import { offsetMinutes } from './time.ts';

export type IcsEvent = {
	uid: string;
	sequence: number;
	title: string;
	description: string | null;
	location: string | null;
	allDay: boolean;
	/** "2026-11-10T09:00" or "2026-11-10". */
	startLocal: string;
	endLocal: string;
	timezone: string;
	rrule: string | null;
	/** Wall-clock starts of skipped occurrences. */
	exdates: string[];
	/** Set on an edited occurrence: the start it replaces. */
	recurrenceLocal: string | null;
	transparency: 'busy' | 'free';
	status: 'confirmed' | 'tentative' | 'cancelled';
	/** UTC, ISO. */
	updatedAt: string;
};

/** Escapes TEXT values: backslash, semicolon, comma and line breaks. */
export function escapeText(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Lines longer than 75 octets continue on the next line after a space, without splitting a character. */
export function foldLine(line: string): string {
	const encoder = new TextEncoder();
	if (encoder.encode(line).length <= 75) return line;
	const out: string[] = [];
	let current = '';
	let size = 0;
	for (const char of line) {
		const bytes = encoder.encode(char).length;
		const limit = out.length === 0 ? 75 : 74;
		if (size + bytes > limit) {
			out.push(current);
			current = '';
			size = 0;
		}
		current += char;
		size += bytes;
	}
	out.push(current);
	return out.join('\r\n ');
}

/** "2026-11-10T09:00" → "20261110T090000"; "2026-11-10" → "20261110". */
function compact(local: string): string {
	return local.length === 10 ? local.replace(/-/g, '') : `${local.replace(/[-:]/g, '')}00`;
}

function utcStamp(iso: string): string {
	return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function offsetText(minutes: number): string {
	const sign = minutes < 0 ? '-' : '+';
	const abs = Math.abs(minutes);
	return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
}

function wallStamp(ms: number, offset: number): string {
	// The wall clock just before the change, in the offset that was in force.
	return utcStamp(new Date(ms + offset * 60_000).toISOString()).replace('Z', '');
}

/** Offset changes in one zone in one year, worked out once per worker. */
const yearChanges = new Map<string, Array<{ at: number; from: number; to: number }>>();
/** Years a VTIMEZONE may cover: a feed can carry any date, and each year costs ~365 Intl calls. */
const MIN_YEAR = 1970;
const MAX_YEAR = 2200;
const MAX_YEARS_PER_ZONE = 12;
const MAX_ZONES = 8;

function changesIn(timezone: string, year: number): Array<{ at: number; from: number; to: number }> {
	const key = `${timezone}|${year}`;
	const cached = yearChanges.get(key);
	if (cached) return cached;
	const start = Date.UTC(year, 0, 1);
	const end = Date.UTC(year + 1, 0, 1);
	const changes: Array<{ at: number; from: number; to: number }> = [];
	let previous = offsetMinutes(start, timezone);
	for (let day = start + DAY; day <= end; day += DAY) {
		const offset = offsetMinutes(day, timezone);
		if (offset === previous) continue;
		// Narrow the change down to the minute.
		let low = day - DAY;
		let high = day;
		while (high - low > 60_000) {
			const middle = low + Math.floor((high - low) / 120_000) * 60_000;
			if (offsetMinutes(middle, timezone) === previous) low = middle;
			else high = middle;
		}
		changes.push({ at: high, from: previous, to: offset });
		previous = offset;
	}
	if (yearChanges.size > 500) yearChanges.clear();
	yearChanges.set(key, changes);
	return changes;
}

/**
 * The VTIMEZONE block a TZID needs (RFC 5545 3.6.5). Without it Gmail shows
 * the invite in UTC. Lists each offset change in the years given, found
 * from Intl, so no time zone tables ship with the app.
 */
export function timezoneLines(timezone: string, years: number[]): string[] {
	if (timezone === 'UTC' || timezone === 'Etc/UTC') {
		return ['BEGIN:VTIMEZONE', `TZID:${timezone}`, 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0000', 'TZOFFSETTO:+0000', 'TZNAME:UTC', 'END:STANDARD', 'END:VTIMEZONE'];
	}
	const chosen = [...new Set(years.filter((year) => Number.isInteger(year) && year >= MIN_YEAR && year <= MAX_YEAR))]
		.sort((a, b) => a - b)
		.slice(0, MAX_YEARS_PER_ZONE);
	const changes = chosen.flatMap((year) => changesIn(timezone, year));
	const lines = ['BEGIN:VTIMEZONE', `TZID:${timezone}`];
	if (changes.length === 0) {
		const offset = offsetText(offsetMinutes(Date.UTC(chosen[0] ?? 2026, 0, 1), timezone));
		lines.push('BEGIN:STANDARD', 'DTSTART:19700101T000000', `TZOFFSETFROM:${offset}`, `TZOFFSETTO:${offset}`, 'END:STANDARD');
	}
	for (const change of changes) {
		const kind = change.to > change.from ? 'DAYLIGHT' : 'STANDARD';
		lines.push(
			`BEGIN:${kind}`,
			`DTSTART:${wallStamp(change.at, change.from)}`,
			`TZOFFSETFROM:${offsetText(change.from)}`,
			`TZOFFSETTO:${offsetText(change.to)}`,
			`END:${kind}`
		);
	}
	lines.push('END:VTIMEZONE');
	return lines;
}

/** VTIMEZONE blocks for the zones timed events use: each event's year and the ones either side. */
function zonesFor(events: Array<{ allDay: boolean; timezone: string; local: string }>): string[] {
	const years = new Map<string, Set<number>>();
	for (const event of events) {
		if (event.allDay) continue;
		const year = Number(event.local.slice(0, 4));
		if (!Number.isInteger(year)) continue;
		let set = years.get(event.timezone);
		if (!set) {
			if (years.size >= MAX_ZONES) continue;
			set = new Set();
			years.set(event.timezone, set);
		}
		for (const near of [year - 1, year, year + 1]) set.add(near);
	}
	return [...years].flatMap(([zone, set]) => {
		try {
			return timezoneLines(zone, [...set]);
		} catch {
			return [];
		}
	});
}

function timeProperty(name: string, local: string, event: IcsEvent): string {
	return event.allDay ? `${name};VALUE=DATE:${compact(local.slice(0, 10))}` : `${name};TZID=${event.timezone}:${compact(local)}`;
}

export function eventLines(event: IcsEvent, extra: string[] = []): string[] {
	const lines = [
		'BEGIN:VEVENT',
		`UID:${event.uid}`,
		`SEQUENCE:${event.sequence}`,
		`DTSTAMP:${utcStamp(event.updatedAt)}`,
		timeProperty('DTSTART', event.startLocal, event),
		timeProperty('DTEND', event.endLocal, event),
		`SUMMARY:${escapeText(event.title)}`
	];
	if (event.recurrenceLocal) lines.push(timeProperty('RECURRENCE-ID', event.recurrenceLocal, event));
	if (event.rrule) lines.push(`RRULE:${event.rrule}`);
	if (event.rrule && event.exdates.length) {
		lines.push(
			event.allDay
				? `EXDATE;VALUE=DATE:${event.exdates.map((day) => compact(day.slice(0, 10))).join(',')}`
				: `EXDATE;TZID=${event.timezone}:${event.exdates.map(compact).join(',')}`
		);
	}
	if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
	if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
	lines.push(`TRANSP:${event.transparency === 'free' ? 'TRANSPARENT' : 'OPAQUE'}`);
	lines.push(`STATUS:${event.status.toUpperCase()}`);
	lines.push(...extra, 'END:VEVENT');
	return lines;
}

/** A whole calendar file, CRLF line endings, folded. */
export function calendarFile(input: {
	name: string;
	timezone: string;
	events: IcsEvent[];
	method?: 'PUBLISH' | 'REQUEST' | 'CANCEL' | 'REPLY';
	/** Extra lines for each event (attendees, organizer). */
	extra?: (event: IcsEvent) => string[];
}): string {
	const lines = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//CloudMail//Calendar//EN',
		'CALSCALE:GREGORIAN',
		`METHOD:${input.method ?? 'PUBLISH'}`,
		`X-WR-CALNAME:${escapeText(input.name)}`,
		`X-WR-TIMEZONE:${input.timezone}`,
		'REFRESH-INTERVAL;VALUE=DURATION:PT15M',
		'X-PUBLISHED-TTL:PT15M',
		...zonesFor(input.events.map((event) => ({ allDay: event.allDay, timezone: event.timezone, local: event.startLocal }))),
		...input.events.flatMap((event) => eventLines(event, input.extra?.(event) ?? [])),
		'END:VCALENDAR'
	];
	return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

export type InvitePerson = { email: string; name: string | null };

/** The answers a guest can give. Anything else is never written into a file. */
export const PARTSTATS = ['NEEDS-ACTION', 'ACCEPTED', 'TENTATIVE', 'DECLINED', 'DELEGATED'] as const;

export function cleanPartstat(value: unknown): (typeof PARTSTATS)[number] {
	const upper = typeof value === 'string' ? value.trim().toUpperCase() : '';
	return (PARTSTATS as readonly string[]).includes(upper) ? (upper as (typeof PARTSTATS)[number]) : 'NEEDS-ACTION';
}

/** An address safe to put after "mailto:" in a file: one bare address, nothing that ends the line or a parameter. */
function cleanAddress(value: string): string {
	return /^[^\s@:;,"<>]+@[^\s@:;,"<>]+$/.test(value) ? value : 'invalid@invalid';
}
export type InviteAttendee = InvitePerson & { partstat: string };

function cn(name: string | null): string {
	// CN is a parameter value: quote it and drop characters that would break it.
	return name ? `;CN="${name.replace(/["\r\n]/g, '').slice(0, 120)}"` : '';
}

/** ORGANIZER and ATTENDEE lines for an invite or an update. */
export function peopleLines(organizer: InvitePerson, attendees: InviteAttendee[]): string[] {
	return [
		`ORGANIZER${cn(organizer.name)}:mailto:${cleanAddress(organizer.email)}`,
		...attendees.map(
			(attendee) =>
				`ATTENDEE${cn(attendee.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=${cleanPartstat(attendee.partstat)};RSVP=TRUE:mailto:${cleanAddress(attendee.email)}`
		)
	];
}

/**
 * An RSVP (METHOD:REPLY) to someone else's invite: who we are, our answer,
 * and enough of the event for their calendar to match it.
 */
export function replyFile(input: {
	uid: string;
	sequence: number;
	title: string;
	organizer: InvitePerson;
	attendee: InvitePerson;
	partstat: 'ACCEPTED' | 'TENTATIVE' | 'DECLINED';
	start: { allDay: boolean; local: string; timezone: string };
	now: Date;
}): string {
	const stamp = utcStamp(input.now.toISOString());
	const start = input.start.allDay
		? `DTSTART;VALUE=DATE:${compact(input.start.local.slice(0, 10))}`
		: `DTSTART;TZID=${input.start.timezone}:${compact(input.start.local)}`;
	const lines = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//CloudMail//Calendar//EN',
		'METHOD:REPLY',
		...zonesFor([input.start]),
		'BEGIN:VEVENT',
		`UID:${input.uid}`,
		`SEQUENCE:${input.sequence}`,
		`DTSTAMP:${stamp}`,
		start,
		`SUMMARY:${escapeText(input.title)}`,
		`ORGANIZER${cn(input.organizer.name)}:mailto:${cleanAddress(input.organizer.email)}`,
		`ATTENDEE${cn(input.attendee.name)};PARTSTAT=${cleanPartstat(input.partstat)}:mailto:${cleanAddress(input.attendee.email)}`,
		'END:VEVENT',
		'END:VCALENDAR'
	];
	return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

/**
 * The organizer turning down a guest's proposed new time (METHOD:DECLINECOUNTER).
 * Carries the event as it stands, so the guest's calendar keeps the current time.
 */
export function declineCounterFile(input: {
	uid: string;
	sequence: number;
	title: string;
	organizer: InvitePerson;
	attendee: InvitePerson;
	start: { allDay: boolean; local: string; timezone: string };
	now: Date;
}): string {
	const start = input.start.allDay
		? `DTSTART;VALUE=DATE:${compact(input.start.local.slice(0, 10))}`
		: `DTSTART;TZID=${input.start.timezone}:${compact(input.start.local)}`;
	const lines = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//CloudMail//Calendar//EN',
		'METHOD:DECLINECOUNTER',
		...zonesFor([input.start]),
		'BEGIN:VEVENT',
		`UID:${input.uid}`,
		`SEQUENCE:${input.sequence}`,
		`DTSTAMP:${utcStamp(input.now.toISOString())}`,
		start,
		`SUMMARY:${escapeText(input.title)}`,
		`ORGANIZER${cn(input.organizer.name)}:mailto:${cleanAddress(input.organizer.email)}`,
		`ATTENDEE${cn(input.attendee.name)}:mailto:${cleanAddress(input.attendee.email)}`,
		'END:VEVENT',
		'END:VCALENDAR'
	];
	return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

