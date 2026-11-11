import { cleanPartstat } from './ics';
import { addDays, formatDate, formatLocal, isTimeZone, parseDate, utcToLocal } from './time';

/**
 * Reads iCalendar (RFC 5545) text: invites, replies and cancellations that
 * arrive by email, and calendars imported from elsewhere. Everything in the
 * file is untrusted: sizes are capped, unknown properties are ignored, and the
 * result is plain data for the store to check again.
 */

export type ParsedProperty = { name: string; params: Record<string, string>; value: string };
export type ParsedComponent = { type: string; props: ParsedProperty[]; children: ParsedComponent[] };

/** Bigger than any real invite; anything larger isn't read. */
export const MAX_ICS_BYTES = 512 * 1024;
const MAX_LINES = 20_000;

/** Joins folded lines and splits each into name, parameters and value. */
export function parseLines(text: string, maxLines = MAX_LINES): ParsedProperty[] {
	const unfolded = text.replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '');
	const out: ParsedProperty[] = [];
	for (const raw of unfolded.split('\n').slice(0, maxLines)) {
		if (!raw.trim()) continue;
		// The value starts at the first colon outside a quoted parameter.
		let quoted = false;
		let split = -1;
		for (let i = 0; i < raw.length; i++) {
			if (raw[i] === '"') quoted = !quoted;
			else if (raw[i] === ':' && !quoted) {
				split = i;
				break;
			}
		}
		if (split < 1) continue;
		const head = raw.slice(0, split);
		const value = raw.slice(split + 1);
		const parts = head.match(/("[^"]*"|[^;])+/g) ?? [];
		const name = (parts.shift() ?? '').trim().toUpperCase();
		if (!name) continue;
		const params: Record<string, string> = {};
		for (const part of parts) {
			const eq = part.indexOf('=');
			if (eq < 1) continue;
			params[part.slice(0, eq).trim().toUpperCase()] = part.slice(eq + 1).trim().replace(/^"|"$/g, '');
		}
		out.push({ name, params, value });
	}
	return out;
}

export function parseComponents(text: string, maxLines = MAX_LINES): ParsedComponent[] {
	const root: ParsedComponent = { type: 'ROOT', props: [], children: [] };
	const stack = [root];
	for (const line of parseLines(text, maxLines)) {
		const top = stack[stack.length - 1];
		if (line.name === 'BEGIN') {
			const child = { type: line.value.trim().toUpperCase(), props: [], children: [] };
			top.children.push(child);
			if (stack.length < 8) stack.push(child);
		} else if (line.name === 'END') {
			if (stack.length > 1) stack.pop();
		} else {
			top.props.push(line);
		}
	}
	return root.children;
}

export function unescapeText(value: string): string {
	return value.replace(/\\([\\;,nN])/g, (_, char: string) => (char === 'n' || char === 'N' ? '\n' : char));
}

/**
 * Windows zone names Outlook and Exchange put in TZID, mapped to IANA. The
 * common ones; anything else falls back to the offsets in the file's VTIMEZONE.
 */
const WINDOWS_ZONES: Record<string, string> = {
	'Dateline Standard Time': 'Etc/GMT+12',
	'Hawaiian Standard Time': 'Pacific/Honolulu',
	'Alaskan Standard Time': 'America/Anchorage',
	'Pacific Standard Time': 'America/Los_Angeles',
	'US Mountain Standard Time': 'America/Phoenix',
	'Mountain Standard Time': 'America/Denver',
	'Central Standard Time': 'America/Chicago',
	'Central America Standard Time': 'America/Guatemala',
	'Canada Central Standard Time': 'America/Regina',
	'Central Standard Time (Mexico)': 'America/Mexico_City',
	'Eastern Standard Time': 'America/New_York',
	'US Eastern Standard Time': 'America/Indiana/Indianapolis',
	'SA Pacific Standard Time': 'America/Bogota',
	'Atlantic Standard Time': 'America/Halifax',
	'Newfoundland Standard Time': 'America/St_Johns',
	'E. South America Standard Time': 'America/Sao_Paulo',
	'Argentina Standard Time': 'America/Argentina/Buenos_Aires',
	'UTC': 'UTC',
	'Coordinated Universal Time': 'UTC',
	'GMT Standard Time': 'Europe/London',
	'Greenwich Standard Time': 'Atlantic/Reykjavik',
	'W. Europe Standard Time': 'Europe/Berlin',
	'Central Europe Standard Time': 'Europe/Budapest',
	'Romance Standard Time': 'Europe/Paris',
	'Central European Standard Time': 'Europe/Warsaw',
	'W. Central Africa Standard Time': 'Africa/Lagos',
	'GTB Standard Time': 'Europe/Bucharest',
	'FLE Standard Time': 'Europe/Kiev',
	'E. Europe Standard Time': 'Europe/Chisinau',
	'Israel Standard Time': 'Asia/Jerusalem',
	'Egypt Standard Time': 'Africa/Cairo',
	'South Africa Standard Time': 'Africa/Johannesburg',
	'Turkey Standard Time': 'Europe/Istanbul',
	'Russian Standard Time': 'Europe/Moscow',
	'Arab Standard Time': 'Asia/Riyadh',
	'Arabian Standard Time': 'Asia/Dubai',
	'Iran Standard Time': 'Asia/Tehran',
	'Pakistan Standard Time': 'Asia/Karachi',
	'India Standard Time': 'Asia/Kolkata',
	'Nepal Standard Time': 'Asia/Kathmandu',
	'Bangladesh Standard Time': 'Asia/Dhaka',
	'SE Asia Standard Time': 'Asia/Bangkok',
	'China Standard Time': 'Asia/Shanghai',
	'Singapore Standard Time': 'Asia/Singapore',
	'Taipei Standard Time': 'Asia/Taipei',
	'W. Australia Standard Time': 'Australia/Perth',
	'Tokyo Standard Time': 'Asia/Tokyo',
	'Korea Standard Time': 'Asia/Seoul',
	'Cen. Australia Standard Time': 'Australia/Adelaide',
	'AUS Central Standard Time': 'Australia/Darwin',
	'E. Australia Standard Time': 'Australia/Brisbane',
	'AUS Eastern Standard Time': 'Australia/Sydney',
	'New Zealand Standard Time': 'Pacific/Auckland'
};

/** The IANA zone for a TZID: itself, a Windows name, or a fixed offset from the file. */
const zoneCache = new WeakMap<ParsedComponent[], Map<string, string>>();

export function resolveZone(tzid: string | undefined, vtimezones: ParsedComponent[], fallback: string): string {
	if (!tzid) return fallback;
	// Each TZID is worked out once per file: a feed can name the same zone thousands of times.
	let cache = zoneCache.get(vtimezones);
	if (!cache) zoneCache.set(vtimezones, (cache = new Map()));
	const key = `${fallback}\u0000${tzid}`;
	const known = cache.get(key);
	if (known) return known;
	const zone = findZone(tzid, vtimezones, fallback);
	if (cache.size < 500) cache.set(key, zone);
	return zone;
}

function findZone(tzid: string, vtimezones: ParsedComponent[], fallback: string): string {
	const clean = tzid.replace(/^\/[^/]*\/[^/]*\//, '').trim();
	if (isTimeZone(clean)) return clean;
	if (WINDOWS_ZONES[clean]) return WINDOWS_ZONES[clean];
	// Last resort: the standard offset the file declares (ignores daylight saving).
	const zone = vtimezones.find((item) => item.props.find((prop) => prop.name === 'TZID')?.value === tzid);
	const standard = zone?.children.find((child) => child.type === 'STANDARD') ?? zone?.children[0];
	const offset = standard?.props.find((prop) => prop.name === 'TZOFFSETTO')?.value.match(/^([+-])(\d{2})(\d{2})/);
	if (offset && offset[3] === '00') {
		const hours = Number(offset[2]);
		if (hours === 0) return 'UTC';
		// Etc/GMT zones have inverted signs.
		const etc = `Etc/GMT${offset[1] === '+' ? '-' : '+'}${hours}`;
		if (isTimeZone(etc)) return etc;
	}
	return fallback;
}

export type IcsTime = { allDay: boolean; local: string; timezone: string };

/**
 * A DATE-TIME or DATE value as wall-clock time plus zone. UTC values ("…Z")
 * and floating values are read in `fallback`, the recipient's own zone.
 */
export function readTime(prop: ParsedProperty | undefined, vtimezones: ParsedComponent[], fallback: string): IcsTime | null {
	if (!prop) return null;
	const value = prop.value.trim().split(',')[0];
	const date = value.match(/^(\d{4})(\d{2})(\d{2})$/);
	if (date || prop.params.VALUE === 'DATE') {
		const match = date ?? value.match(/^(\d{4})(\d{2})(\d{2})/);
		if (!match) return null;
		const day = parseDate(`${match[1]}-${match[2]}-${match[3]}`);
		return day ? { allDay: true, local: formatDate(day), timezone: fallback } : null;
	}
	const time = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z?)$/);
	if (!time) return null;
	const [, y, mo, d, h, mi, , z] = time;
	if (z) {
		const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi);
		if (!Number.isFinite(ms)) return null;
		return { allDay: false, local: formatLocal(utcToLocal(ms, fallback)), timezone: fallback };
	}
	const zone = resolveZone(prop.params.TZID, vtimezones, fallback);
	return { allDay: false, local: `${y}-${mo}-${d}T${h}:${mi}`, timezone: zone };
}

/** "PT1H30M", "P1D", "P2W": in minutes. */
export function durationMinutes(value: string): number | null {
	const match = value.trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
	if (!match) return null;
	const [, sign, w, d, h, m] = match;
	const minutes = (+(w ?? 0) * 7 + +(d ?? 0)) * 1440 + +(h ?? 0) * 60 + +(m ?? 0);
	return sign === '-' ? -minutes : minutes;
}

export type ParsedPerson = { email: string; name: string | null };
export type ParsedAttendee = ParsedPerson & { partstat: string; role: string | null };

function person(prop: ParsedProperty): ParsedPerson | null {
	const email = prop.value.replace(/^mailto:/i, '').trim().toLowerCase();
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return null;
	const name = prop.params.CN?.trim().slice(0, 120) || null;
	return { email, name };
}

export type ParsedEvent = {
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
	status: 'confirmed' | 'tentative' | 'cancelled';
	transparency: 'busy' | 'free';
	organizer: ParsedPerson | null;
	attendees: ParsedAttendee[];
};

export type ParsedCalendar = { method: string | null; events: ParsedEvent[] };

const text = (props: ParsedProperty[], name: string, max: number) => {
	const prop = props.find((item) => item.name === name);
	return prop ? unescapeText(prop.value).trim().slice(0, max) || null : null;
};

/** How much of a file to read. Invites are small; a whole calendar's feed is not. */
export type ParseLimits = { maxBytes: number; maxLines: number; maxEvents: number };
const INVITE_LIMITS: ParseLimits = { maxBytes: MAX_ICS_BYTES, maxLines: MAX_LINES, maxEvents: 200 };
const MAX_VTIMEZONES = 50;
const MAX_EXDATES = 500;
export const FEED_LIMITS: ParseLimits = { maxBytes: 5 * 1024 * 1024, maxLines: 400_000, maxEvents: 20_000 };

/** Reads a calendar file's events. `fallbackZone` is the recipient's own zone. */
export function parseCalendar(input: string, fallbackZone = 'UTC', limits: ParseLimits = INVITE_LIMITS): ParsedCalendar {
	if (new TextEncoder().encode(input).length > limits.maxBytes) return { method: null, events: [] };
	const calendars = parseComponents(input, limits.maxLines).filter((component) => component.type === 'VCALENDAR');
	const calendar = calendars[0];
	if (!calendar) return { method: null, events: [] };
	const method = calendar.props.find((prop) => prop.name === 'METHOD')?.value.trim().toUpperCase() || null;
	// A real calendar declares a handful of zones; more is padding.
	const vtimezones = calendar.children.filter((child) => child.type === 'VTIMEZONE').slice(0, MAX_VTIMEZONES);
	const events: ParsedEvent[] = [];
	for (const component of calendar.children.filter((child) => child.type === 'VEVENT').slice(0, limits.maxEvents)) {
		const props = component.props;
		const uid = props.find((prop) => prop.name === 'UID')?.value.trim().slice(0, 255);
		const start = readTime(props.find((prop) => prop.name === 'DTSTART'), vtimezones, fallbackZone);
		if (!uid || !start) continue;
		let end = readTime(props.find((prop) => prop.name === 'DTEND'), vtimezones, fallbackZone);
		if (end && end.allDay !== start.allDay) end = null;
		if (end && !start.allDay && end.timezone !== start.timezone) {
			// Different zones for start and end: keep the start's zone, same span.
			end = null;
		}
		if (!end) {
			const minutes = durationMinutes(props.find((prop) => prop.name === 'DURATION')?.value ?? '');
			if (start.allDay) {
				const days = minutes !== null ? Math.max(1, Math.round(minutes / 1440)) : 1;
				end = { ...start, local: formatDate(addDays(parseDate(start.local)!, days)) };
			} else {
				const [date, clock] = start.local.split('T');
				const [h, m] = clock.split(':').map(Number);
				const total = h * 60 + m + Math.max(0, minutes ?? 60);
				const day = addDays(parseDate(date)!, Math.floor(total / 1440));
				const rest = total % 1440;
				end = {
					...start,
					local: `${formatDate(day)}T${String(Math.floor(rest / 60)).padStart(2, '0')}:${String(rest % 60).padStart(2, '0')}`
				};
			}
		}
		const exdates: string[] = [];
		exdate: for (const prop of props.filter((item) => item.name === 'EXDATE')) {
			for (const value of prop.value.split(',', MAX_EXDATES)) {
				if (exdates.length >= MAX_EXDATES) break exdate;
				const time = readTime({ ...prop, value }, vtimezones, start.timezone);
				if (time) exdates.push(start.allDay ? `${time.local.slice(0, 10)}T00:00` : time.local);
			}
		}
		const recurrence = readTime(props.find((prop) => prop.name === 'RECURRENCE-ID'), vtimezones, start.timezone);
		const status = props.find((prop) => prop.name === 'STATUS')?.value.trim().toUpperCase();
		const organizerProp = props.find((prop) => prop.name === 'ORGANIZER');
		const attendees: ParsedAttendee[] = [];
		for (const prop of props.filter((item) => item.name === 'ATTENDEE').slice(0, 200)) {
			const who = person(prop);
			if (who) attendees.push({ ...who, partstat: cleanPartstat(prop.params.PARTSTAT), role: prop.params.ROLE?.slice(0, 40) ?? null });
		}
		const sequence = Number(props.find((prop) => prop.name === 'SEQUENCE')?.value ?? 0);
		const rrule = props.find((prop) => prop.name === 'RRULE')?.value.trim().toUpperCase() ?? null;
		events.push({
			uid,
			sequence: Number.isInteger(sequence) && sequence >= 0 ? sequence : 0,
			title: text(props, 'SUMMARY', 200) ?? '(No title)',
			description: text(props, 'DESCRIPTION', 10_000),
			location: text(props, 'LOCATION', 500),
			allDay: start.allDay,
			startLocal: start.local,
			endLocal: end.local,
			timezone: start.timezone,
			rrule: rrule && rrule.length <= 500 ? rrule : null,
			exdates,
			recurrenceLocal: recurrence ? (start.allDay ? `${recurrence.local.slice(0, 10)}T00:00` : recurrence.local) : null,
			status: status === 'CANCELLED' ? 'cancelled' : status === 'TENTATIVE' ? 'tentative' : 'confirmed',
			transparency: props.find((prop) => prop.name === 'TRANSP')?.value.trim().toUpperCase() === 'TRANSPARENT' ? 'free' : 'busy',
			organizer: organizerProp ? person(organizerProp) : null,
			attendees
		});
	}
	return { method, events };
}

/** The series (no RECURRENCE-ID) and its edited occurrences, for one UID. */
export function groupByUid(events: ParsedEvent[]): Map<string, { series: ParsedEvent | null; edits: ParsedEvent[] }> {
	const groups = new Map<string, { series: ParsedEvent | null; edits: ParsedEvent[] }>();
	for (const event of events) {
		const group = groups.get(event.uid) ?? { series: null, edits: [] };
		if (event.recurrenceLocal) group.edits.push(event);
		else group.series = event;
		groups.set(event.uid, group);
	}
	return groups;
}

