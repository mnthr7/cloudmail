import { addDays, formatDate, localToUtc, utcToLocal, weekday, type LocalDate } from './time.ts';
import { WEEKDAYS, type Weekday } from './recurrence.ts';

/**
 * Calendar step 4: which times a booking page offers. Pure, so it can be
 * tested on its own: weekly hours in the page's zone, minus busy time (with a
 * buffer either side), minus anything too soon or too far out.
 */

/** Weekly hours, e.g. { MO: [["09:00", "12:00"], ["13:00", "17:00"]] }. "24:00" is the end of the day. */
export type WeeklyHours = Partial<Record<Weekday, Array<[string, string]>>>;

export type BookingRules = {
	timezone: string;
	hours: WeeklyHours;
	durationMinutes: number;
	bufferMinutes: number;
	minNoticeMinutes: number;
	horizonDays: number;
	/** Most bookings on one day (in the page's zone). */
	maxPerDay: number;
};

export type Interval = { start: number; end: number };
export type Slot = { start: number; end: number; date: string };

export const DURATIONS = [15, 20, 30, 45, 60, 90, 120] as const;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$|^24:00$/;

export function minutesOf(time: string): number | null {
	if (!TIME.test(time)) return null;
	const [h, m] = time.split(':').map(Number);
	return h * 60 + m;
}

/** Checks weekly hours: real times, each window forward, at most three a day, not overlapping. */
export function readHours(value: unknown): WeeklyHours | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const out: WeeklyHours = {};
	for (const [day, windows] of Object.entries(value as Record<string, unknown>)) {
		if (!(WEEKDAYS as readonly string[]).includes(day)) return null;
		if (!Array.isArray(windows) || windows.length > 3) return null;
		const clean: Array<[string, string]> = [];
		let lastEnd = -1;
		const sorted = [...windows].sort((a, b) => String(a?.[0]).localeCompare(String(b?.[0])));
		for (const window of sorted) {
			if (!Array.isArray(window) || window.length !== 2) return null;
			const [from, to] = window;
			if (typeof from !== 'string' || typeof to !== 'string') return null;
			const a = minutesOf(from);
			const b = minutesOf(to);
			if (a === null || b === null || a >= b || a < lastEnd) return null;
			lastEnd = b;
			clean.push([from, to]);
		}
		if (clean.length) out[day as Weekday] = clean;
	}
	return out;
}

/** Monday to Friday, 9 to 5. */
export const DEFAULT_HOURS: WeeklyHours = {
	MO: [['09:00', '17:00']],
	TU: [['09:00', '17:00']],
	WE: [['09:00', '17:00']],
	TH: [['09:00', '17:00']],
	FR: [['09:00', '17:00']]
};

function at(date: LocalDate, minutes: number, zone: string): number {
	if (minutes >= 1440) return localToUtc({ ...addDays(date, 1), hour: 0, minute: 0 }, zone);
	return localToUtc({ ...date, hour: Math.floor(minutes / 60), minute: minutes % 60 }, zone);
}

/**
 * Open slots between `from` and `to` (UTC ms). `busy` is every busy interval
 * that might touch them; `booked` counts bookings already on each local date
 * ("2026-11-12"), for the daily limit. Slots start on the quarter or half hour.
 */
export function freeSlots(input: {
	rules: BookingRules;
	busy: Interval[];
	booked?: Record<string, number>;
	from: number;
	to: number;
	now: number;
}): Slot[] {
	const { rules } = input;
	const duration = rules.durationMinutes * 60_000;
	const buffer = rules.bufferMinutes * 60_000;
	const step = (rules.durationMinutes % 30 === 0 ? 30 : 15) * 60_000;
	const earliest = Math.max(input.from, input.now + rules.minNoticeMinutes * 60_000);
	const latest = Math.min(input.to, input.now + rules.horizonDays * 86_400_000);
	if (!(latest > earliest)) return [];
	const busy = [...input.busy].sort((a, b) => a.start - b.start);

	const out: Slot[] = [];
	const first = utcToLocal(earliest - 86_400_000, rules.timezone);
	let date: LocalDate = { year: first.year, month: first.month, day: first.day };
	for (let i = 0; i < 400; i++, date = addDays(date, 1)) {
		const dayStart = at(date, 0, rules.timezone);
		if (dayStart > latest) break;
		const key = formatDate(date);
		if ((input.booked?.[key] ?? 0) >= rules.maxPerDay) continue;
		const windows = rules.hours[WEEKDAYS[weekday(date)]] ?? [];
		for (const [fromText, toText] of windows) {
			const windowStart = at(date, minutesOf(fromText)!, rules.timezone);
			const windowEnd = at(date, minutesOf(toText)!, rules.timezone);
			for (let start = windowStart; start + duration <= windowEnd; start += step) {
				if (start < earliest || start + duration > latest) continue;
				const end = start + duration;
				const clash = busy.some((item) => item.start - buffer < end && item.end + buffer > start);
				if (!clash) out.push({ start, end, date: key });
			}
		}
	}
	return out;
}
