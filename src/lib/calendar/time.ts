/**
 * Wall-clock time in a named time zone, and back. Events are stored as local
 * time plus an IANA zone (America/Chicago), so "9:00 every Monday" stays at
 * 9:00 across daylight-saving changes. Uses Intl, which Workers and browsers ship.
 */

/** A date and time on a wall clock, without a zone. Months are 1–12. */
export type LocalDateTime = { year: number; month: number; day: number; hour: number; minute: number };
export type LocalDate = { year: number; month: number; day: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
	let found = formatters.get(timeZone);
	if (!found) {
		found = new Intl.DateTimeFormat('en-US', {
			timeZone,
			hourCycle: 'h23',
			year: 'numeric',
			month: 'numeric',
			day: 'numeric',
			hour: 'numeric',
			minute: 'numeric',
			second: 'numeric'
		});
		formatters.set(timeZone, found);
	}
	return found;
}

export function isTimeZone(value: unknown): value is string {
	if (typeof value !== 'string' || !value || value.length > 64) return false;
	try {
		formatter(value);
		return true;
	} catch {
		return false;
	}
}

/** The wall clock in `timeZone` at a UTC instant. */
export function utcToLocal(ms: number, timeZone: string): LocalDateTime {
	const parts: Record<string, number> = {};
	for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
		if (part.type !== 'literal') parts[part.type] = Number(part.value);
	}
	return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute };
}

/** Minutes `timeZone` is ahead of UTC at an instant. */
export function offsetMinutes(ms: number, timeZone: string): number {
	const local = utcToLocal(ms, timeZone);
	const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
	return Math.round((asUtc - Math.floor(ms / 60_000) * 60_000) / 60_000);
}

/**
 * The UTC instant a wall-clock time in `timeZone` happens. A time skipped by
 * a spring-forward change moves later by the gap (2:30 becomes 3:30); a time
 * that happens twice in the fall uses the first.
 */
export function localToUtc(local: LocalDateTime, timeZone: string): number {
	const wall = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
	// The zone's offset half a day either side covers any transition near this time.
	const before = offsetMinutes(wall - 12 * 3_600_000, timeZone);
	const after = offsetMinutes(wall + 12 * 3_600_000, timeZone);
	const candidates = [...new Set([before, after])].map((offset) => wall - offset * 60_000);
	const valid = candidates.filter((ms) => sameWall(utcToLocal(ms, timeZone), local));
	if (valid.length) return Math.min(...valid);
	// Skipped by spring forward: read it with the offset from before the jump.
	return wall - before * 60_000;
}

function sameWall(a: LocalDateTime, b: LocalDateTime): boolean {
	return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute;
}

const pad = (value: number, size = 2) => String(value).padStart(size, '0');

/** "2026-11-10T09:00" */
export function formatLocal(local: LocalDateTime): string {
	return `${pad(local.year, 4)}-${pad(local.month)}-${pad(local.day)}T${pad(local.hour)}:${pad(local.minute)}`;
}

/** "2026-11-10" */
export function formatDate(date: LocalDate): string {
	return `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`;
}

export function parseLocal(value: unknown): LocalDateTime | null {
	if (typeof value !== 'string') return null;
	const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
	if (!match) return null;
	const local = {
		year: Number(match[1]),
		month: Number(match[2]),
		day: Number(match[3]),
		hour: Number(match[4]),
		minute: Number(match[5])
	};
	return validDate(local) && local.hour < 24 && local.minute < 60 ? local : null;
}

export function parseDate(value: unknown): LocalDate | null {
	if (typeof value !== 'string') return null;
	const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!match) return null;
	const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
	return validDate(date) ? date : null;
}

export function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function validDate(date: LocalDate): boolean {
	return (
		date.year >= 1900 && date.year <= 2200 && date.month >= 1 && date.month <= 12 && date.day >= 1 && date.day <= daysInMonth(date.year, date.month)
	);
}

/** Calendar arithmetic on dates, with no time zone involved. */
export function addDays(date: LocalDate, days: number): LocalDate {
	const ms = Date.UTC(date.year, date.month - 1, date.day) + days * 86_400_000;
	const next = new Date(ms);
	return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(date: LocalDate): number {
	return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** Whole days from `a` to `b`. */
export function daysBetween(a: LocalDate, b: LocalDate): number {
	return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

export function compareDates(a: LocalDate, b: LocalDate): number {
	return daysBetween(b, a);
}
