import {
	addDays,
	daysBetween,
	daysInMonth,
	localToUtc,
	weekday,
	type LocalDate,
	type LocalDateTime
} from './time';

/**
 * Repeating events (RFC 5545 RRULE). Covers what calendars actually send:
 * FREQ (DAILY, WEEKLY, MONTHLY, YEARLY), INTERVAL, COUNT, UNTIL, BYDAY (with
 * ordinals like 2TU or -1FR), BYMONTHDAY, BYMONTH and BYSETPOS. Occurrences
 * are worked out on the wall clock in the event's zone, then turned into UTC,
 * so a 9:00 meeting stays at 9:00 through daylight-saving changes.
 */

export type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
const FREQUENCIES: Frequency[] = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];

export const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export type Rule = {
	freq: Frequency;
	interval: number;
	count?: number;
	/** Last allowed start, as a UTC instant in ms. */
	until?: number;
	/** Weekdays, each optionally with an ordinal within the month or year (2 = second, -1 = last). */
	byDay?: Array<{ day: Weekday; nth?: number }>;
	byMonthDay?: number[];
	byMonth?: number[];
	bySetPos?: number[];
};

export class RuleError extends Error {
	constructor(message = 'rrule') {
		super(message);
		this.name = 'RuleError';
	}
}

function ints(value: string, min: number, max: number, allowNegative = false): number[] {
	const list = value.split(',').map((item) => Number(item.trim()));
	for (const item of list) {
		const size = Math.abs(item);
		if (!Number.isInteger(item) || size < min || size > max || (!allowNegative && item < 0)) throw new RuleError();
	}
	return list;
}

/** "20261231T235959Z" or "20261231" (taken as the end of that day in the event's zone). */
function parseUntil(value: string, timeZone: string): number {
	const utc = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
	if (utc) return Date.UTC(+utc[1], +utc[2] - 1, +utc[3], +utc[4], +utc[5], +utc[6]);
	const local = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?$/);
	if (!local) throw new RuleError();
	return localToUtc(
		{ year: +local[1], month: +local[2], day: +local[3], hour: local[4] ? +local[4] : 23, minute: local[5] ? +local[5] : 59 },
		timeZone
	);
}

export function parseRule(text: string, timeZone = 'UTC'): Rule {
	const raw = text.trim().replace(/^RRULE:/i, '');
	if (!raw || raw.length > 500) throw new RuleError();
	const fields = new Map<string, string>();
	for (const part of raw.split(';')) {
		const [key, value] = part.split('=');
		if (!key || value === undefined) throw new RuleError();
		fields.set(key.trim().toUpperCase(), value.trim().toUpperCase());
	}
	const freq = fields.get('FREQ') as Frequency;
	if (!FREQUENCIES.includes(freq)) throw new RuleError();
	const rule: Rule = { freq, interval: 1 };
	if (fields.has('INTERVAL')) rule.interval = ints(fields.get('INTERVAL')!, 1, 1000)[0];
	if (fields.has('COUNT')) rule.count = ints(fields.get('COUNT')!, 1, 5000)[0];
	if (fields.has('UNTIL')) rule.until = parseUntil(fields.get('UNTIL')!, timeZone);
	if (fields.has('BYDAY')) {
		rule.byDay = fields.get('BYDAY')!.split(',').map((item) => {
			const match = item.trim().match(/^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/);
			if (!match) throw new RuleError();
			const nth = match[1] ? Number(match[1]) : undefined;
			if (nth !== undefined && (nth === 0 || Math.abs(nth) > 53)) throw new RuleError();
			return { day: match[2] as Weekday, ...(nth !== undefined ? { nth } : {}) };
		});
	}
	if (fields.has('BYMONTHDAY')) rule.byMonthDay = ints(fields.get('BYMONTHDAY')!, 1, 31, true);
	if (fields.has('BYMONTH')) rule.byMonth = ints(fields.get('BYMONTH')!, 1, 12);
	if (fields.has('BYSETPOS')) rule.bySetPos = ints(fields.get('BYSETPOS')!, 1, 366, true);
	return rule;
}

/** Back to RRULE text, in a stable order. */
export function formatRule(rule: Rule): string {
	const parts = [`FREQ=${rule.freq}`];
	if (rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`);
	if (rule.byDay?.length) parts.push(`BYDAY=${rule.byDay.map((item) => `${item.nth ?? ''}${item.day}`).join(',')}`);
	if (rule.byMonthDay?.length) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(',')}`);
	if (rule.byMonth?.length) parts.push(`BYMONTH=${rule.byMonth.join(',')}`);
	if (rule.bySetPos?.length) parts.push(`BYSETPOS=${rule.bySetPos.join(',')}`);
	if (rule.count) parts.push(`COUNT=${rule.count}`);
	if (rule.until !== undefined) {
		parts.push(`UNTIL=${new Date(rule.until).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`);
	}
	return parts.join(';');
}

const dayIndex = (day: Weekday) => WEEKDAYS.indexOf(day);

/** Every date in a month that matches one BYDAY entry (all of them, or the nth). */
function weekdaysInMonth(year: number, month: number, entry: { day: Weekday; nth?: number }): LocalDate[] {
	const target = dayIndex(entry.day);
	const all: LocalDate[] = [];
	for (let day = 1; day <= daysInMonth(year, month); day++) {
		const date = { year, month, day };
		if (weekday(date) === target) all.push(date);
	}
	if (entry.nth === undefined) return all;
	const picked = entry.nth > 0 ? all[entry.nth - 1] : all[all.length + entry.nth];
	return picked ? [picked] : [];
}

function monthDays(year: number, month: number, list: number[]): LocalDate[] {
	const size = daysInMonth(year, month);
	return list
		.map((day) => (day > 0 ? day : size + day + 1))
		.filter((day) => day >= 1 && day <= size)
		.map((day) => ({ year, month, day }));
}

function sortUnique(dates: LocalDate[]): LocalDate[] {
	const seen = new Map<number, LocalDate>();
	for (const date of dates) seen.set(Date.UTC(date.year, date.month - 1, date.day), date);
	return [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, date]) => date);
}

function applySetPos(dates: LocalDate[], positions?: number[]): LocalDate[] {
	if (!positions?.length) return dates;
	return sortUnique(
		positions.map((pos) => (pos > 0 ? dates[pos - 1] : dates[dates.length + pos])).filter((date): date is LocalDate => !!date)
	);
}

/** The candidate dates in one period (a day, week, month or year), in order. */
function periodDates(rule: Rule, start: LocalDate, period: number): LocalDate[] {
	switch (rule.freq) {
		case 'DAILY': {
			const date = addDays(start, period * rule.interval);
			if (rule.byMonth && !rule.byMonth.includes(date.month)) return [];
			if (rule.byMonthDay && !monthDays(date.year, date.month, rule.byMonthDay).some((d) => d.day === date.day)) return [];
			if (rule.byDay && !rule.byDay.some((entry) => dayIndex(entry.day) === weekday(date))) return [];
			return [date];
		}
		case 'WEEKLY': {
			// Weeks start on Monday (WKST=MO, the default).
			const monday = addDays(start, -((weekday(start) + 6) % 7) + period * rule.interval * 7);
			const days = rule.byDay?.length ? rule.byDay.map((entry) => dayIndex(entry.day)) : [weekday(start)];
			const dates = days.map((day) => addDays(monday, (day + 6) % 7));
			const kept = dates.filter((date) => !rule.byMonth || rule.byMonth.includes(date.month));
			return applySetPos(sortUnique(kept), rule.bySetPos);
		}
		case 'MONTHLY': {
			const index = start.month - 1 + period * rule.interval;
			const year = start.year + Math.floor(index / 12);
			const month = (index % 12) + 1;
			if (rule.byMonth && !rule.byMonth.includes(month)) return [];
			let dates: LocalDate[];
			if (rule.byDay?.length) {
				dates = rule.byDay.flatMap((entry) => weekdaysInMonth(year, month, entry));
				if (rule.byMonthDay) {
					const allowed = new Set(monthDays(year, month, rule.byMonthDay).map((date) => date.day));
					dates = dates.filter((date) => allowed.has(date.day));
				}
			} else {
				dates = monthDays(year, month, rule.byMonthDay ?? [start.day]);
			}
			return applySetPos(sortUnique(dates), rule.bySetPos);
		}
		case 'YEARLY': {
			const year = start.year + period * rule.interval;
			const months = rule.byMonth ?? [start.month];
			let dates: LocalDate[] = [];
			for (const month of months) {
				if (rule.byDay?.length) {
					dates.push(...rule.byDay.flatMap((entry) => weekdaysInMonth(year, month, entry)));
				} else {
					dates.push(...monthDays(year, month, rule.byMonthDay ?? [start.day]));
				}
			}
			if (rule.byDay?.length && rule.byMonthDay) {
				dates = dates.filter((date) => monthDays(date.year, date.month, rule.byMonthDay!).some((d) => d.day === date.day));
			}
			return applySetPos(sortUnique(dates), rule.bySetPos);
		}
	}
}

/** How far back to look each period, so expansion stays bounded. */
const MAX_PERIODS = 20_000;
const MAX_OCCURRENCES = 5_000;

export type Occurrence = {
	/** The occurrence's own wall-clock start, which identifies it (RECURRENCE-ID). */
	local: LocalDateTime;
	/** UTC start in ms. */
	start: number;
};

/**
 * Occurrences of a repeating event that start before `rangeEnd` and end after
 * `rangeStart` (both UTC ms). The first occurrence is always the event's own
 * start, as RFC 5545 requires. `excluded` holds wall-clock starts to skip
 * (EXDATE, or occurrences replaced by an edited copy).
 */
export function expandRule(input: {
	rule: Rule;
	start: LocalDateTime;
	timeZone: string;
	durationMs: number;
	rangeStart: number;
	rangeEnd: number;
	excluded?: Set<string>;
	/** All-day events repeat on dates; their instants are midnights in the zone. */
	allDay?: boolean;
}): Occurrence[] {
	const { rule, start, timeZone } = input;
	const startDate: LocalDate = { year: start.year, month: start.month, day: start.day };
	const out: Occurrence[] = [];
	let produced = 0;

	// No zone is more than 14 hours from UTC, so a wall time this far before the
	// window (and before UNTIL) can be counted without converting it exactly.
	const SLACK = 15 * 3_600_000;
	const emit = (date: LocalDate): boolean => {
		const local: LocalDateTime = { ...date, hour: start.hour, minute: start.minute };
		const wall = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
		if (wall + SLACK + input.durationMs < input.rangeStart && (rule.until === undefined || wall + SLACK < rule.until)) {
			produced++;
			return !(rule.count !== undefined && produced >= rule.count);
		}
		const ms = localToUtc(local, timeZone);
		if (rule.until !== undefined && ms > rule.until) return false;
		produced++;
		const key = keyOf(local);
		if (ms < input.rangeEnd && ms + input.durationMs > input.rangeStart && !input.excluded?.has(key)) {
			out.push({ local, start: ms });
		}
		return !(rule.count !== undefined && produced >= rule.count) && out.length < MAX_OCCURRENCES;
	};

	if (!emit(startDate)) return out;
	for (let period = 0; period < MAX_PERIODS; period++) {
		const dates = periodDates(rule, startDate, period);
		let beyond = false;
		for (const date of dates) {
			if (daysBetween(startDate, date) <= 0) continue;
			// Past the window: nothing later can land inside it.
			if (Date.UTC(date.year, date.month - 1, date.day, start.hour, start.minute) - SLACK >= input.rangeEnd) {
				beyond = true;
				break;
			}
			if (!emit(date)) return out;
		}
		if (beyond) break;
	}
	return out;
}

/** "2026-11-10T09:00": identifies one occurrence. */
export function keyOf(local: LocalDateTime): string {
	const pad = (value: number, size = 2) => String(value).padStart(size, '0');
	return `${pad(local.year, 4)}-${pad(local.month)}-${pad(local.day)}T${pad(local.hour)}:${pad(local.minute)}`;
}

/** Plain-English summary for the editor and event details. */
export function describeRule(rule: Rule): string {
	const every = (unit: string) => (rule.interval === 1 ? `Every ${unit}` : `Every ${rule.interval} ${unit}s`);
	const names: Record<Weekday, string> = { SU: 'Sun', MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat' };
	const ordinal = (n: number) => (n === -1 ? 'last' : n === 1 ? 'first' : n === 2 ? 'second' : n === 3 ? 'third' : n === 4 ? 'fourth' : `${n}th`);
	let text: string;
	switch (rule.freq) {
		case 'DAILY':
			text = every('day');
			break;
		case 'WEEKLY': {
			const days = rule.byDay?.map((entry) => entry.day) ?? [];
			const weekdaysOnly = days.length === 5 && ['MO', 'TU', 'WE', 'TH', 'FR'].every((day) => days.includes(day as Weekday));
			text =
				weekdaysOnly && rule.interval === 1
					? 'Every weekday'
					: `${every('week')}${days.length ? ` on ${days.map((day) => names[day]).join(', ')}` : ''}`;
			break;
		}
		case 'MONTHLY': {
			const entry = rule.byDay?.[0];
			text =
				entry?.nth !== undefined
					? `${every('month')} on the ${ordinal(entry.nth)} ${names[entry.day]}`
					: rule.byMonthDay?.length
						? `${every('month')} on day ${rule.byMonthDay.join(', ')}`
						: every('month');
			break;
		}
		case 'YEARLY':
			text = every('year');
			break;
	}
	if (rule.count) text += `, ${rule.count} times`;
	if (rule.until !== undefined) text += `, until ${new Date(rule.until).toISOString().slice(0, 10)}`;
	return text;
}
