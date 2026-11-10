/**
 * iCalendar (RFC 5545) output: the subscribe feed now, invites later. Times
 * carry their IANA zone as TZID, which Google, Apple and Outlook all read, so
 * repeating events keep their wall-clock time on the phone too.
 */

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

