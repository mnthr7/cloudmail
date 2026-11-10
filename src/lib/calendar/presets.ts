import { formatRule, parseRule, WEEKDAYS, type Rule } from './recurrence';
import { localToUtc, weekday, type LocalDate } from './time';

/**
 * The editor's "Repeat" menu: a few common choices for the event's start
 * date, turned into RRULE text and back. Anything else shows as "Custom" and
 * is kept exactly as it was.
 */

export type RepeatPreset = 'none' | 'daily' | 'weekly' | 'weekdays' | 'monthly_day' | 'monthly_weekday' | 'yearly' | 'custom';
export type RepeatEnd = { kind: 'never' } | { kind: 'on'; date: LocalDate } | { kind: 'after'; count: number };

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Which week of the month a date falls in: 1–4, or -1 when it's the last such weekday. */
function weekOfMonth(date: LocalDate): number {
	const nth = Math.ceil(date.day / 7);
	const daysLeft = new Date(Date.UTC(date.year, date.month, 0)).getUTCDate() - date.day;
	return daysLeft < 7 && nth >= 4 ? -1 : nth;
}

function ordinal(n: number): string {
	return n === -1 ? 'last' : ['first', 'second', 'third', 'fourth', 'fifth'][n - 1] ?? `${n}th`;
}

export function presetLabels(start: LocalDate): Array<{ value: RepeatPreset; label: string }> {
	const day = DAY_NAMES[weekday(start)];
	return [
		{ value: 'none', label: "Doesn't repeat" },
		{ value: 'daily', label: 'Every day' },
		{ value: 'weekly', label: `Every week on ${day}` },
		{ value: 'weekdays', label: 'Every weekday (Mon–Fri)' },
		{ value: 'monthly_day', label: `Every month on day ${start.day}` },
		{ value: 'monthly_weekday', label: `Every month on the ${ordinal(weekOfMonth(start))} ${day}` },
		{ value: 'yearly', label: `Every year on ${MONTH_NAMES[start.month - 1]} ${start.day}` }
	];
}

/** RRULE text for a preset, or null for "doesn't repeat". `custom` keeps `existing`. */
export function ruleFor(
	preset: RepeatPreset,
	start: LocalDate,
	end: RepeatEnd,
	timeZone: string,
	existing: string | null = null
): string | null {
	if (preset === 'none') return null;
	if (preset === 'custom') return existing;
	const day = WEEKDAYS[weekday(start)];
	const rule: Rule = { freq: 'DAILY', interval: 1 };
	switch (preset) {
		case 'daily':
			break;
		case 'weekly':
			rule.freq = 'WEEKLY';
			rule.byDay = [{ day }];
			break;
		case 'weekdays':
			rule.freq = 'WEEKLY';
			rule.byDay = (['MO', 'TU', 'WE', 'TH', 'FR'] as const).map((item) => ({ day: item }));
			break;
		case 'monthly_day':
			rule.freq = 'MONTHLY';
			rule.byMonthDay = [start.day];
			break;
		case 'monthly_weekday':
			rule.freq = 'MONTHLY';
			rule.byDay = [{ day, nth: weekOfMonth(start) }];
			break;
		case 'yearly':
			rule.freq = 'YEARLY';
			break;
	}
	if (end.kind === 'after') rule.count = Math.max(1, Math.min(5000, Math.round(end.count)));
	// "Ends on" a date includes that whole day in the event's zone.
	if (end.kind === 'on') rule.until = localToUtc({ ...end.date, hour: 23, minute: 59 }, timeZone);
	return formatRule(rule);
}

/** Which preset a stored rule is, and how it ends, for opening the editor. */
export function presetOf(
	rrule: string | null,
	start: LocalDate,
	timeZone: string
): { preset: RepeatPreset; end: RepeatEnd } {
	if (!rrule) return { preset: 'none', end: { kind: 'never' } };
	let rule: Rule;
	try {
		rule = parseRule(rrule, timeZone);
	} catch {
		return { preset: 'custom', end: { kind: 'never' } };
	}
	const end: RepeatEnd =
		rule.count !== undefined
			? { kind: 'after', count: rule.count }
			: rule.until !== undefined
				? (() => {
						const date = new Date(rule.until!);
						const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
							.format(date)
							.split('-')
							.map(Number);
						return { kind: 'on', date: { year: parts[0], month: parts[1], day: parts[2] } } as RepeatEnd;
					})()
				: { kind: 'never' };
	const bare = formatRule({ ...rule, count: undefined, until: undefined });
	for (const preset of ['daily', 'weekly', 'weekdays', 'monthly_day', 'monthly_weekday', 'yearly'] as const) {
		if (ruleFor(preset, start, { kind: 'never' }, timeZone) === bare) return { preset, end };
	}
	return { preset: 'custom', end };
}
