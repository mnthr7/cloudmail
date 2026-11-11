import type { D1Database } from '@cloudflare/workers-types';
import {
	DEFAULT_HOURS,
	DURATIONS,
	freeSlots,
	readHours,
	type BookingRules,
	type Interval,
	type Slot,
	type WeeklyHours
} from '#lib/calendar/availability.ts';
import { addDays, formatLocal, isTimeZone, localToUtc, parseDate, utcToLocal } from '#lib/calendar/time.ts';
import type { User } from '#lib/types.ts';
import { APP_NOTICE_HEADER } from '#lib/organizing/categories.ts';
import { CalendarError, createEvent, listCalendars, occurrencesInRange, seriesOf, setSendFrom } from './calendar-store.ts';
import { replaceAttendees, sendInvites } from './calendar-invites.ts';
import type { EmailProvider } from './email-provider.ts';
import { resolveFromAddress } from './outbox.ts';
import { sendOutboundEmail } from './send-mail.ts';

/**
 * Calendar step 4: booking pages. A public link (/book/<slug>) shows open
 * times from your weekly hours minus everything busy on every calendar you
 * have, outside ones included. Booking puts the meeting on your calendar,
 * sends the guest a real invite, and tells you by email.
 */

export class BookingError extends Error {
	readonly status: number;
	constructor(
		readonly code:
			| 'slug'
			| 'slug_taken'
			| 'title'
			| 'text'
			| 'durations'
			| 'hours'
			| 'timezone'
			| 'numbers'
			| 'calendar'
			| 'from'
			| 'missing'
			| 'name'
			| 'email'
			| 'taken'
			| 'too_many'
			| 'slow_down'
			| 'limit'
			| 'location'
			| 'questions'
			| 'phone'
			| 'answers'
			| 'guests'
			| 'cancelled'
			| 'past'
			| 'changed'
			| 'not_verified'
	) {
		super(code);
		this.name = 'BookingError';
		this.status = code === 'missing' ? 404 : code === 'taken' || code === 'slug_taken' ? 409 : code === 'slow_down' ? 429 : 400;
	}
}

export type BookingPage = {
	id: string;
	slug: string;
	title: string;
	description: string | null;
	durations: number[];
	timezone: string;
	hours: WeeklyHours;
	bufferMinutes: number;
	minNoticeMinutes: number;
	horizonDays: number;
	maxPerDay: number;
	calendarId: string;
	sendFrom: string | null;
	location: string | null;
	enabled: boolean;
	locationKind: LocationKind;
	/** How the location reads on the page, in the host's words. Null: the default wording. */
	locationText: string | null;
	askPhone: AskPhone;
	questions: Question[];
	allowGuests: boolean;
	reminderMinutes: number;
};

export const LOCATION_KINDS = ['none', 'video', 'phone_guest', 'phone_host', 'in_person', 'custom'] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];
export type AskPhone = 'off' | 'optional' | 'required';
export type Question = { id: string; label: string; long: boolean; required: boolean };
export const REMINDER_CHOICES = [0, 60, 120, 1440, 2880] as const;

type PageRow = {
	id: string;
	user_id: string;
	slug: string;
	title: string;
	description: string | null;
	durations_json: string;
	timezone: string;
	hours_json: string;
	buffer_minutes: number;
	min_notice_minutes: number;
	horizon_days: number;
	max_per_day: number;
	calendar_id: string;
	send_from: string | null;
	location: string | null;
	enabled: number;
	location_kind?: string | null;
	location_label?: string | null;
	ask_phone?: string | null;
	questions_json?: string | null;
	allow_guests?: number | null;
	reminder_minutes?: number | null;
};

function toPage(row: PageRow): BookingPage {
	let durations: number[] = [30];
	let hours: WeeklyHours = DEFAULT_HOURS;
	try {
		durations = (JSON.parse(row.durations_json) as number[]).filter((value) => (DURATIONS as readonly number[]).includes(value));
	} catch {
		// keep the default
	}
	try {
		hours = readHours(JSON.parse(row.hours_json)) ?? DEFAULT_HOURS;
	} catch {
		// keep the default
	}
	return {
		id: row.id,
		slug: row.slug,
		title: row.title,
		description: row.description,
		durations: durations.length ? durations : [30],
		timezone: row.timezone,
		hours,
		bufferMinutes: row.buffer_minutes,
		minNoticeMinutes: row.min_notice_minutes,
		horizonDays: row.horizon_days,
		maxPerDay: row.max_per_day,
		calendarId: row.calendar_id,
		sendFrom: row.send_from,
		location: row.location,
		enabled: row.enabled === 1,
		locationKind: (LOCATION_KINDS as readonly string[]).includes(row.location_kind ?? '')
			? (row.location_kind as LocationKind)
			: row.location
				? 'custom'
				: 'none',
		locationText: row.location_label ?? null,
		askPhone: row.ask_phone === 'optional' || row.ask_phone === 'required' ? row.ask_phone : 'off',
		questions: parseQuestions(row.questions_json),
		allowGuests: row.allow_guests === 1,
		reminderMinutes: row.reminder_minutes ?? 1440
	};
}

function parseQuestions(text: string | null | undefined): Question[] {
	try {
		const list = JSON.parse(text ?? '[]') as Question[];
		return Array.isArray(list) ? list.slice(0, MAX_QUESTIONS) : [];
	} catch {
		return [];
	}
}

const MAX_QUESTIONS = 5;
const PHONE = /^\+?[\d\s().-]{7,24}$/;

/** A phone number as typed: digits with the usual punctuation, 7 to 15 digits. */
export function readPhone(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const text = value.trim().replace(/\s+/g, ' ');
	const digits = text.replace(/\D/g, '');
	if (!PHONE.test(text) || digits.length < 7 || digits.length > 15) return null;
	return text;
}

/** "Zoom", "Google Meet", "Microsoft Teams", or "Video call" for any other link. */
export function videoProvider(link: string): string {
	try {
		const host = new URL(link).hostname.toLowerCase();
		if (host === 'zoom.us' || host.endsWith('.zoom.us')) return 'Zoom';
		if (host === 'meet.google.com') return 'Google Meet';
		if (host === 'teams.microsoft.com' || host === 'teams.live.com') return 'Microsoft Teams';
		if (host.endsWith('webex.com')) return 'Webex';
		if (host === 'whereby.com' || host.endsWith('.whereby.com')) return 'Whereby';
	} catch {
		// not a link
	}
	return 'Video call';
}

const MAX_PAGES = 10;
const RESERVED = new Set(['admin', 'api', 'new', 'edit', 'settings', 'login', 'book', 'help', 'support', 'www', 'mail']);

function readSlug(value: unknown): string {
	if (typeof value !== 'string') throw new BookingError('slug');
	const slug = value.trim().toLowerCase();
	if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(slug) || slug.includes('--') || RESERVED.has(slug)) {
		throw new BookingError('slug');
	}
	return slug;
}

function readText(value: unknown, max: number, required: 'title' | null = null): string | null {
	if (value === undefined || value === null || value === '') {
		if (required) throw new BookingError(required);
		return null;
	}
	if (typeof value !== 'string') throw new BookingError('text');
	const text = value.trim();
	if (required && !text) throw new BookingError(required);
	if (text.length > max) throw new BookingError(required ?? 'text');
	return text || null;
}

function readInt(value: unknown, min: number, max: number, fallback: number): number {
	if (value === undefined || value === null) return fallback;
	const number = Number(value);
	if (!Number.isInteger(number) || number < min || number > max) throw new BookingError('numbers');
	return number;
}

/** Checks a page's settings. `current` fills in what the input leaves out. */
async function readPage(
	db: D1Database,
	userId: string,
	ownAddresses: string[],
	input: Record<string, unknown>,
	current?: BookingPage
): Promise<Omit<BookingPage, 'id'>> {
	const slug = input.slug === undefined && current ? current.slug : readSlug(input.slug);
	const title = input.title === undefined && current ? current.title : readText(input.title, 120, 'title')!;
	const description = input.description === undefined ? (current?.description ?? null) : readText(input.description, 1000);
	const locationKind = (input.locationKind ?? current?.locationKind ?? 'none') as LocationKind;
	if (!(LOCATION_KINDS as readonly unknown[]).includes(locationKind)) throw new BookingError('location');
	let location = input.location === undefined ? (current?.location ?? null) : readText(input.location, 500);
	if (locationKind === 'none' || locationKind === 'phone_guest') location = null;
	else if (!location) throw new BookingError('location');
	else if (locationKind === 'video') {
		let link: URL | null = null;
		try {
			link = new URL(location);
		} catch {
			link = null;
		}
		if (!link || link.protocol !== 'https:') throw new BookingError('location');
	} else if (locationKind === 'phone_host' && !readPhone(location)) throw new BookingError('location');

	let askPhone: AskPhone = (input.askPhone ?? current?.askPhone ?? 'off') as AskPhone;
	if (!['off', 'optional', 'required'].includes(askPhone)) throw new BookingError('numbers');
	// If you call them, you need their number.
	if (locationKind === 'phone_guest') askPhone = 'required';

	let questions = current?.questions ?? [];
	if (input.questions !== undefined) {
		if (!Array.isArray(input.questions) || input.questions.length > MAX_QUESTIONS) throw new BookingError('questions');
		const used = new Set<string>();
		questions = input.questions.map((raw, index) => {
			const item = (raw ?? {}) as Record<string, unknown>;
			const label = typeof item.label === 'string' ? item.label.trim() : '';
			if (!label || label.length > 200) throw new BookingError('questions');
			let id = typeof item.id === 'string' && /^[a-z0-9]{1,12}$/.test(item.id) ? item.id : `q${index + 1}`;
			while (used.has(id)) id = `${id}x`.slice(-12);
			used.add(id);
			return { id, label, long: item.long === true, required: item.required === true };
		});
	}

	const reminderMinutes = input.reminderMinutes === undefined ? (current?.reminderMinutes ?? 1440) : Number(input.reminderMinutes);
	if (!(REMINDER_CHOICES as readonly number[]).includes(reminderMinutes)) throw new BookingError('numbers');

	let durations = current?.durations ?? [30];
	if (input.durations !== undefined) {
		if (!Array.isArray(input.durations) || input.durations.length < 1 || input.durations.length > 4) {
			throw new BookingError('durations');
		}
		const set = [...new Set(input.durations)];
		if (!set.every((value) => (DURATIONS as readonly unknown[]).includes(value))) throw new BookingError('durations');
		durations = (set as number[]).sort((a, b) => a - b);
	}

	const timezone = input.timezone ?? current?.timezone;
	if (!isTimeZone(timezone)) throw new BookingError('timezone');

	let hours = current?.hours ?? DEFAULT_HOURS;
	if (input.hours !== undefined) {
		const read = readHours(input.hours);
		if (!read || Object.keys(read).length === 0) throw new BookingError('hours');
		hours = read;
	}

	const calendars = (await listCalendars(db, userId)).filter((calendar) => !calendar.source);
	const calendarId =
		input.calendarId === undefined
			? (current?.calendarId ?? (calendars.find((calendar) => calendar.isDefault) ?? calendars[0])?.id)
			: input.calendarId;
	if (typeof calendarId !== 'string' || !calendars.some((calendar) => calendar.id === calendarId)) {
		throw new BookingError('calendar');
	}

	let sendFrom = current?.sendFrom ?? null;
	if (input.sendFrom !== undefined) {
		if (input.sendFrom === null || input.sendFrom === '') sendFrom = null;
		else if (typeof input.sendFrom === 'string' && ownAddresses.includes(input.sendFrom.toLowerCase())) {
			sendFrom = input.sendFrom.toLowerCase();
		} else throw new BookingError('from');
	}

	return {
		slug,
		title,
		description,
		durations,
		timezone,
		hours,
		bufferMinutes: readInt(input.bufferMinutes, 0, 120, current?.bufferMinutes ?? 0),
		minNoticeMinutes: readInt(input.minNoticeMinutes, 0, 14 * 1440, current?.minNoticeMinutes ?? 240),
		horizonDays: readInt(input.horizonDays, 1, 120, current?.horizonDays ?? 30),
		maxPerDay: readInt(input.maxPerDay, 1, 50, current?.maxPerDay ?? 8),
		calendarId,
		sendFrom,
		location,
		enabled: input.enabled === undefined ? (current?.enabled ?? true) : input.enabled === true,
		locationKind,
		locationText:
			locationKind === 'none'
				? null
				: input.locationText === undefined
					? (current?.locationText ?? null)
					: readText(input.locationText, 120),
		askPhone,
		questions,
		allowGuests: input.allowGuests === undefined ? (current?.allowGuests ?? false) : input.allowGuests === true,
		reminderMinutes
	};
}

function v2Values(page: Omit<BookingPage, 'id'>): unknown[] {
	return [
		page.locationKind,
		page.askPhone,
		JSON.stringify(page.questions),
		page.allowGuests ? 1 : 0,
		page.reminderMinutes,
		page.locationText
	];
}

export async function listBookingPages(db: D1Database, userId: string): Promise<BookingPage[]> {
	const { results } = await db
		.prepare(`SELECT * FROM booking_pages WHERE user_id = ? ORDER BY created_at`)
		.bind(userId)
		.all<PageRow>();
	return results.map(toPage);
}

async function ownedPage(db: D1Database, userId: string, id: string): Promise<BookingPage> {
	const row = await db.prepare(`SELECT * FROM booking_pages WHERE id = ? AND user_id = ?`).bind(id, userId).first<PageRow>();
	if (!row) throw new BookingError('missing');
	return toPage(row);
}

function isUnique(error: unknown): boolean {
	return error instanceof Error && /UNIQUE/i.test(error.message);
}

export async function createBookingPage(
	db: D1Database,
	userId: string,
	ownAddresses: string[],
	input: Record<string, unknown>,
	now = new Date()
): Promise<BookingPage> {
	const count = await db.prepare(`SELECT COUNT(*) AS n FROM booking_pages WHERE user_id = ?`).bind(userId).first<{ n: number }>();
	if ((count?.n ?? 0) >= MAX_PAGES) throw new BookingError('limit');
	const page = await readPage(db, userId, ownAddresses, input);
	const id = crypto.randomUUID();
	const at = now.toISOString();
	try {
		await db
			.prepare(
				`INSERT INTO booking_pages (id, user_id, slug, title, description, durations_json, timezone, hours_json, buffer_minutes,
				   min_notice_minutes, horizon_days, max_per_day, calendar_id, send_from, location, enabled, created_at, updated_at,
				   location_kind, ask_phone, questions_json, allow_guests, reminder_minutes, location_label)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				id,
				userId,
				page.slug,
				page.title,
				page.description,
				JSON.stringify(page.durations),
				page.timezone,
				JSON.stringify(page.hours),
				page.bufferMinutes,
				page.minNoticeMinutes,
				page.horizonDays,
				page.maxPerDay,
				page.calendarId,
				page.sendFrom,
				page.location,
				page.enabled ? 1 : 0,
				at,
				at,
				...v2Values(page)
			)
			.run();
	} catch (error) {
		if (isUnique(error)) throw new BookingError('slug_taken');
		throw error;
	}
	return { id, ...page };
}

export async function updateBookingPage(
	db: D1Database,
	userId: string,
	ownAddresses: string[],
	id: string,
	input: Record<string, unknown>,
	now = new Date()
): Promise<BookingPage> {
	const current = await ownedPage(db, userId, id);
	const page = await readPage(db, userId, ownAddresses, input, current);
	try {
		await db
			.prepare(
				`UPDATE booking_pages SET slug = ?, title = ?, description = ?, durations_json = ?, timezone = ?, hours_json = ?,
				   buffer_minutes = ?, min_notice_minutes = ?, horizon_days = ?, max_per_day = ?, calendar_id = ?, send_from = ?,
				   location = ?, enabled = ?, updated_at = ?,
				   location_kind = ?, ask_phone = ?, questions_json = ?, allow_guests = ?, reminder_minutes = ?, location_label = ?
				 WHERE id = ? AND user_id = ?`
			)
			.bind(
				page.slug,
				page.title,
				page.description,
				JSON.stringify(page.durations),
				page.timezone,
				JSON.stringify(page.hours),
				page.bufferMinutes,
				page.minNoticeMinutes,
				page.horizonDays,
				page.maxPerDay,
				page.calendarId,
				page.sendFrom,
				page.location,
				page.enabled ? 1 : 0,
				now.toISOString(),
				...v2Values(page),
				id,
				userId
			)
			.run();
	} catch (error) {
		if (isUnique(error)) throw new BookingError('slug_taken');
		throw error;
	}
	return { id, ...page };
}

export async function deleteBookingPage(db: D1Database, userId: string, id: string): Promise<void> {
	await ownedPage(db, userId, id);
	await db.prepare(`DELETE FROM booking_pages WHERE id = ? AND user_id = ?`).bind(id, userId).run();
}

// ---------------------------------------------------------------------------
// The public side

export type PublicPage = {
	slug: string;
	title: string;
	description: string | null;
	durations: number[];
	timezone: string;
	/** What visitors see before booking: "Zoom", "Phone call", an address. Links come in the invite. */
	location: { kind: LocationKind; label: string } | null;
	host: string;
	askPhone: AskPhone;
	questions: Question[];
	allowGuests: boolean;
};

/** How the location reads before booking (no links or numbers yet). */
export function locationLabel(
	page: Pick<BookingPage, 'locationKind' | 'location'> & { locationText?: string | null; hostName?: string }
): { kind: LocationKind; label: string } | null {
	if (page.locationKind === 'none') return null;
	// The host's own words, if they wrote some.
	if (page.locationText) return { kind: page.locationKind, label: page.locationText };
	const host = page.hostName?.trim().split(/\s+/)[0] || 'your host';
	switch (page.locationKind) {
		case 'video':
			return { kind: 'video', label: videoProvider(page.location ?? '') };
		case 'phone_guest':
			return { kind: 'phone_guest', label: `Phone call: ${host} will call you` };
		case 'phone_host':
			return { kind: 'phone_host', label: `Phone call: you call ${host} (number in your invite)` };
		case 'in_person':
			return { kind: 'in_person', label: page.location ?? 'In person' };
		case 'custom':
			return page.location ? { kind: 'custom', label: page.location } : null;
		default:
			return null;
	}
}

/** What goes in the event's location for this booking. */
function eventLocation(page: LivePage, phone: string | null): string | null {
	switch (page.locationKind) {
		case 'phone_guest':
			// Their number stays with you (on the booking), not with everyone invited.
			return `Phone call: ${page.hostName} will call you`;
		case 'phone_host':
			return `Phone call: ${page.location}`;
		case 'none':
			return null;
		default:
			return page.location;
	}
}

export type LivePage = BookingPage & { userId: string; hostName: string };

/** A page by its link. Turned-off pages only with `includeOff` (a guest changing what they already booked). */
export async function pageBySlug(db: D1Database, slug: string, includeOff = false): Promise<LivePage | null> {
	if (!/^[a-z0-9-]{3,40}$/.test(slug)) return null;
	const row = await db
		.prepare(
			`SELECT p.*, u.name AS host_name FROM booking_pages p JOIN users u ON u.id = p.user_id
			 WHERE p.slug = ? AND (p.enabled = 1 OR ?)`
		)
		.bind(slug, includeOff ? 1 : 0)
		.first<PageRow & { host_name: string | null }>();
	if (!row) return null;
	return { ...toPage(row), userId: row.user_id, hostName: row.host_name?.trim() || 'Your host' };
}

/** What a visitor sees: no hours, calendars or addresses, just enough to pick a time. */
export async function publicPage(db: D1Database, slug: string, includeOff = false): Promise<PublicPage | null> {
	const page = await pageBySlug(db, slug, includeOff);
	if (!page) return null;
	return {
		slug: page.slug,
		title: page.title,
		description: page.description,
		durations: page.durations,
		timezone: page.timezone,
		location: locationLabel(page),
		host: page.hostName,
		askPhone: page.askPhone,
		questions: page.questions,
		allowGuests: page.allowGuests
	};
}

/** Everything that blocks time for this person: every calendar, outside ones included, plus held slots. */
async function busyFor(
	db: D1Database,
	userId: string,
	from: number,
	to: number,
	now: Date,
	ignoreEventId: string | null = null
): Promise<Interval[]> {
	const calendars = await listCalendars(db, userId);
	const occurrences = await occurrencesInRange(db, calendars, from, to);
	const busy: Interval[] = occurrences
		// When rescheduling, the meeting being moved doesn't block itself.
		.filter((item) => item.transparency === 'busy' && item.myStatus !== 'declined' && item.eventId !== ignoreEventId)
		.map((item) => ({ start: Date.parse(item.start), end: Date.parse(item.end) }));
	// A booking still being written (its event isn't there yet) holds its time for a couple of minutes.
	const { results } = await db
		.prepare(
			`SELECT start_at, end_at FROM bookings
			 WHERE user_id = ? AND event_id IS NULL AND status = 'confirmed' AND created_at > ? AND start_at < ? AND end_at > ?`
		)
		.bind(userId, new Date(now.getTime() - HOLD_MS).toISOString(), new Date(to).toISOString(), new Date(from).toISOString())
		.all<{ start_at: string; end_at: string }>();
	for (const row of results) busy.push({ start: Date.parse(row.start_at), end: Date.parse(row.end_at) });
	return busy;
}

const HOLD_MS = 2 * 60_000;

async function bookedPerDay(
	db: D1Database,
	page: BookingPage,
	from: number,
	to: number,
	now: Date,
	ignoreEventId: string | null
): Promise<Record<string, number>> {
	const { results } = await db
		.prepare(
			`SELECT start_at FROM bookings WHERE page_id = ? AND start_at >= ? AND start_at < ? AND status = 'confirmed'
			   AND (event_id IS NOT NULL OR created_at > ?) AND (event_id IS NULL OR event_id <> ?)`
		)
		.bind(
			page.id,
			new Date(from - 86_400_000).toISOString(),
			new Date(to + 86_400_000).toISOString(),
			new Date(now.getTime() - HOLD_MS).toISOString(),
			ignoreEventId ?? ''
		)
		.all<{ start_at: string }>();
	const out: Record<string, number> = {};
	for (const row of results) {
		const local = utcToLocal(Date.parse(row.start_at), page.timezone);
		const key = formatLocal(local).slice(0, 10);
		out[key] = (out[key] ?? 0) + 1;
	}
	return out;
}

function rulesOf(page: BookingPage, duration: number): BookingRules {
	return {
		timezone: page.timezone,
		hours: page.hours,
		durationMinutes: duration,
		bufferMinutes: page.bufferMinutes,
		minNoticeMinutes: page.minNoticeMinutes,
		horizonDays: page.horizonDays,
		maxPerDay: page.maxPerDay
	};
}

/** At most six weeks of slots per request (a month on screen). */
const MAX_WINDOW_MS = 43 * 86_400_000;

export async function openSlots(
	db: D1Database,
	slug: string,
	input: { from: number; to: number; duration: number },
	now = new Date()
): Promise<Slot[]> {
	const page = await pageBySlug(db, slug);
	if (!page) throw new BookingError('missing');
	return slotsFor(db, page, input, now);
}

/** Open slots on a page. `ignoreEventId`: the meeting being moved, which doesn't count as busy. */
export async function slotsFor(
	db: D1Database,
	page: LivePage,
	input: { from: number; to: number; duration: number },
	now = new Date(),
	ignoreEventId: string | null = null
): Promise<Slot[]> {
	if (!page.durations.includes(input.duration)) throw new BookingError('durations');
	const from = Math.max(input.from, now.getTime());
	const to = Math.min(input.to, from + MAX_WINDOW_MS, now.getTime() + page.horizonDays * 86_400_000);
	if (!(to > from)) return [];
	const pad = (page.bufferMinutes + 24 * 60) * 60_000;
	const busy = await busyFor(db, page.userId, from - pad, to + pad, now, ignoreEventId);
	return freeSlots({
		rules: rulesOf(page, input.duration),
		busy,
		booked: await bookedPerDay(db, page, from, to, now, ignoreEventId),
		from,
		to,
		now: now.getTime()
	});
}

const EMAIL = /^[^\s@,;<>"()\[\]\\]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/**
 * A guest's name as it may appear in an invite: letters, spaces, apostrophes
 * and hyphens. No dots, colons or slashes, so it can't carry a link or domain.
 */
export function cleanName(value: unknown): string {
	if (typeof value !== 'string') throw new BookingError('name');
	const name = value
		.normalize('NFKC')
		.replace(/[^\p{L}\p{M}\s'’-]/gu, '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 60);
	if (name.length < 1) throw new BookingError('name');
	return name;
}

/** One guest however they write their address: no +tags, and Gmail ignores dots. */
export function guestKey(email: string): string {
	const [local, domain] = email.toLowerCase().split('@');
	let name = local.split('+')[0];
	if (domain === 'gmail.com' || domain === 'googlemail.com') name = name.replace(/\./g, '');
	return `${name}@${domain === 'googlemail.com' ? 'gmail.com' : domain}`;
}

const PER_HOUR = 10;
/** Emails one page may cause in a day (invites, updates, cancellations), counted per recipient. */
export const SENDS_PER_DAY = 40;
/** Upcoming bookings one person may be part of on a page, as booker or extra guest. */
const AHEAD_PER_GUEST = 3;

export type BookingResult = { start: string; end: string; invited: boolean };

const MAX_EXTRA_GUESTS = 3;

/** The manage link's token: 32 random bytes, URL-safe. Only its hash is stored. */
export function newToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function tokenHash(token: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The token sits after "#", so it never reaches a server log; the page sends it in a request body. */
export function manageUrl(origin: string, token: string): string {
	return `${origin}/book/manage#${token}`;
}

/**
 * Claims room in the page's daily email budget for `recipients` emails, in one
 * statement. False: the page has sent its share today.
 */
export async function claimSends(
	db: D1Database,
	pageId: string,
	bookingId: string | null,
	kind: string,
	recipients: number,
	now: Date
): Promise<boolean> {
	if (recipients <= 0) return true;
	const result = await db
		.prepare(
			`INSERT INTO booking_sends (id, page_id, booking_id, kind, recipients, created_at)
			 SELECT ?, ?, ?, ?, ?, ?
			 WHERE (SELECT COALESCE(SUM(recipients), 0) FROM booking_sends WHERE page_id = ? AND created_at > ?) + ? <= ?`
		)
		.bind(
			crypto.randomUUID(),
			pageId,
			bookingId,
			kind,
			recipients,
			now.toISOString(),
			pageId,
			new Date(now.getTime() - 86_400_000).toISOString(),
			recipients,
			SENDS_PER_DAY
		)
		.run();
	return !!result.meta.changes;
}

/** The line the guest's invite carries, so they can change the meeting themselves. */
export function manageLine(origin: string, token: string): string {
	return `Need to make a change? Reschedule or cancel: ${manageUrl(origin, token)}`;
}

export function formatWhen(start: number, end: number, zone: string): string {
	const day = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(start));
	const time = (ms: number, withZone: boolean) =>
		new Intl.DateTimeFormat('en-US', {
			timeZone: zone,
			hour: 'numeric',
			minute: '2-digit',
			...(withZone ? { timeZoneName: 'short' as const } : {})
		}).format(new Date(ms));
	return `${day}, ${time(start, false)} – ${time(end, true)}`;
}

export type Answer = { id: string; label: string; value: string };

/** The guest's answers to the page's questions, checked against what's required. */
function readAnswers(page: BookingPage, value: unknown): Answer[] {
	const given = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	const out: Answer[] = [];
	for (const question of page.questions) {
		const raw = given[question.id];
		const text = typeof raw === 'string' ? raw.trim().slice(0, question.long ? 2000 : 300) : '';
		if (!text) {
			if (question.required) throw new BookingError('answers');
			continue;
		}
		out.push({ id: question.id, label: question.label, value: text });
	}
	return out;
}

function readExtraGuests(page: BookingPage, value: unknown, main: string): Array<{ email: string; name: null }> {
	if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) return [];
	if (!page.allowGuests || !Array.isArray(value) || value.length > MAX_EXTRA_GUESTS) throw new BookingError('guests');
	const seen = new Set([guestKey(main)]);
	const out: Array<{ email: string; name: null }> = [];
	for (const item of value) {
		const email = typeof item === 'string' ? item.trim().toLowerCase() : '';
		if (email.length > 254 || !EMAIL.test(email)) throw new BookingError('guests');
		const key = guestKey(email);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ email, name: null });
	}
	return out;
}

/**
 * Books a slot. The time is checked again here, a short hold stops two people
 * taking it at once, and limits keep the page from being used to flood your
 * calendar or someone's inbox.
 */
export async function bookSlot(
	db: D1Database,
	provider: EmailProvider | null,
	slug: string,
	input: {
		start: unknown;
		duration: unknown;
		name: unknown;
		email: unknown;
		note: unknown;
		phone?: unknown;
		answers?: unknown;
		guests?: unknown;
		timezone?: unknown;
	},
	options: { uidDomain: string; origin?: string; now?: Date }
): Promise<BookingResult> {
	const now = options.now ?? new Date();
	const origin = options.origin ?? `https://${options.uidDomain}`;
	const page = await pageBySlug(db, slug);
	if (!page) throw new BookingError('missing');
	const duration = Number(input.duration);
	if (!page.durations.includes(duration)) throw new BookingError('durations');
	const start = typeof input.start === 'string' ? Date.parse(input.start) : NaN;
	if (!Number.isFinite(start)) throw new BookingError('taken');
	const name = cleanName(input.name);
	const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
	if (email.length > 254 || !EMAIL.test(email)) throw new BookingError('email');
	const note = typeof input.note === 'string' ? input.note.trim().slice(0, 1000) || null : null;
	let phone: string | null = null;
	if (page.askPhone !== 'off') {
		const typed = typeof input.phone === 'string' ? input.phone.trim() : '';
		if (typed) {
			phone = readPhone(typed);
			if (!phone) throw new BookingError('phone');
		} else if (page.askPhone === 'required') throw new BookingError('phone');
	}
	const answers = readAnswers(page, input.answers);
	const extraGuests = readExtraGuests(page, input.guests, email);
	const guestZone = isTimeZone(input.timezone) ? input.timezone : null;

	const key = guestKey(email);
	const keysJson = JSON.stringify([key, ...extraGuests.map((guest) => guestKey(guest.email))]);
	const recipients = 1 + extraGuests.length;
	const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
	const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
	const holdCutoff = new Date(now.getTime() - HOLD_MS).toISOString();
	// No more than a handful of bookings an hour from one page, and three ahead per guest.
	// Checked here for a clear answer, and again inside the hold so parallel tries can't pass.
	const limits = async () => {
		const recent = await db
			.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE page_id = ? AND created_at > ?`)
			.bind(page.id, hourAgo)
			.first<{ n: number }>();
		if ((recent?.n ?? 0) >= PER_HOUR) throw new BookingError('slow_down');
		const today = await db
			.prepare(`SELECT COALESCE(SUM(recipients), 0) AS n FROM booking_sends WHERE page_id = ? AND created_at > ?`)
			.bind(page.id, dayAgo)
			.first<{ n: number }>();
		if ((today?.n ?? 0) + recipients > SENDS_PER_DAY) throw new BookingError('slow_down');
		const busiest = await db
			.prepare(
				`SELECT COUNT(*) AS n FROM bookings b, json_each(b.guest_keys_json) k
				 WHERE b.page_id = ? AND b.start_at > ? AND b.status = 'confirmed' AND (b.event_id IS NOT NULL OR b.created_at > ?)
				   AND k.value IN (SELECT value FROM json_each(?))
				 GROUP BY k.value ORDER BY n DESC LIMIT 1`
			)
			.bind(page.id, now.toISOString(), holdCutoff, keysJson)
			.first<{ n: number }>();
		if ((busiest?.n ?? 0) >= AHEAD_PER_GUEST) throw new BookingError('too_many');
	};
	await limits();

	const end = start + duration * 60_000;
	const day = 86_400_000;
	const open = await slotsFor(db, page, { from: start - day, to: end + day, duration }, now);
	const slot = open.find((item) => item.start === start);
	if (!slot) throw new BookingError('taken');

	// The hold: one statement, so a second booking for an overlapping time can't slip in.
	const bookingId = crypto.randomUUID();
	const token = newToken();
	const startIso = new Date(start).toISOString();
	const endIso = new Date(end).toISOString();
	const dayStart = localToUtc({ ...parseDate(slot.date)!, hour: 0, minute: 0 }, page.timezone);
	const dayEnd = localToUtc({ ...addDays(parseDate(slot.date)!, 1), hour: 0, minute: 0 }, page.timezone);
	const hold = await db
		.prepare(
			`INSERT INTO bookings (id, page_id, user_id, guest_name, guest_email, guest_key, note, start_at, end_at, created_at,
			                       guest_phone, answers_json, extra_guests_json, guest_timezone, manage_token_hash, guest_keys_json)
			 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
			 WHERE NOT EXISTS (
			   SELECT 1 FROM bookings WHERE user_id = ? AND start_at < ? AND end_at > ? AND status = 'confirmed'
			     AND (event_id IS NOT NULL OR created_at > ?)
			 )
			 AND (SELECT COUNT(*) FROM bookings WHERE page_id = ? AND created_at > ?) < ?
			 AND (SELECT COALESCE(SUM(recipients), 0) FROM booking_sends WHERE page_id = ? AND created_at > ?) + ? <= ?
			 AND NOT EXISTS (
			   SELECT 1 FROM bookings b, json_each(b.guest_keys_json) k
			   WHERE b.page_id = ? AND b.start_at > ? AND b.status = 'confirmed' AND (b.event_id IS NOT NULL OR b.created_at > ?)
			     AND k.value IN (SELECT value FROM json_each(?))
			   GROUP BY k.value HAVING COUNT(*) >= ?
			 )
			 AND (SELECT COUNT(*) FROM bookings WHERE page_id = ? AND start_at >= ? AND start_at < ? AND status = 'confirmed'
			        AND (event_id IS NOT NULL OR created_at > ?)) < ?`
		)
		.bind(
			bookingId,
			page.id,
			page.userId,
			name,
			email,
			key,
			note,
			startIso,
			endIso,
			now.toISOString(),
			phone,
			JSON.stringify(answers),
			JSON.stringify(extraGuests.map((guest) => guest.email)),
			guestZone,
			await tokenHash(token),
			keysJson,
			page.userId,
			endIso,
			startIso,
			holdCutoff,
			page.id,
			hourAgo,
			PER_HOUR,
			page.id,
			dayAgo,
			recipients,
			SENDS_PER_DAY,
			page.id,
			now.toISOString(),
			holdCutoff,
			keysJson,
			AHEAD_PER_GUEST,
			page.id,
			new Date(dayStart).toISOString(),
			new Date(dayEnd).toISOString(),
			holdCutoff,
			page.maxPerDay
		)
		.run();
	if (!hold.meta.changes) {
		await limits();
		throw new BookingError('taken');
	}
	// Remembered so mail sent later (by an agent, from the cron) links back to this site.
	// First one wins (the owner's hire sets it too), and never a preview or workers.dev address.
	if (options.origin && !/\.workers\.dev$/i.test(new URL(options.origin).hostname)) {
		await db.prepare(`UPDATE booking_pages SET site_origin = ? WHERE id = ? AND site_origin IS NULL`).bind(options.origin, page.id).run();
	}
	// The invites this booking sends count against the page's day. The hold checked there was room,
	// but two bookings at once can both pass that check: the claim is the one that counts.
	if (!(await claimSends(db, page.id, bookingId, 'booked', recipients, now))) {
		await db.prepare(`DELETE FROM bookings WHERE id = ? AND event_id IS NULL`).bind(bookingId).run();
		throw new BookingError('slow_down');
	}

	try {
		const owner = await db.prepare(`SELECT * FROM users WHERE id = ?`).bind(page.userId).first<User>();
		if (!owner) throw new BookingError('missing');
		const local = (ms: number) => formatLocal(utcToLocal(ms, page.timezone));
		const eventId = await createEvent(
			db,
			page.userId,
			{
				calendarId: page.calendarId,
				title: `${page.title}: ${name}`,
				// What every guest's invite says. Their answers, note and change link don't go here.
				description: page.description,
				location: eventLocation(page, phone),
				start: local(start),
				end: local(end),
				timezone: page.timezone
			},
			{ now, uidDomain: options.uidDomain }
		);
		await db.prepare(`UPDATE bookings SET event_id = ? WHERE id = ?`).bind(eventId, bookingId).run();
		await setSendFrom(db, eventId, page.sendFrom);
		await replaceAttendees(db, eventId, [{ email, name }, ...extraGuests]);

		let invited = false;
		if (provider) {
			const series = await seriesOf(db, page.userId, eventId);
			// Only the booker's own copy carries the link to reschedule or cancel.
			const result = await sendInvites(db, provider, owner, series, {
				privateLines: { [email]: manageLine(origin, token) }
			}).catch((error) => {
				console.error('Booking invite failed', bookingId, error);
				return { sent: 0, error: 'send' };
			});
			invited = result.sent > 0;
			await notifyOwner(db, provider, owner, page, 'booked', {
				name,
				email,
				phone,
				note,
				answers,
				guests: extraGuests.map((guest) => guest.email),
				start,
				end
			}).catch((error) => console.error('Booking notice failed', bookingId, error));
		}
		return { start: startIso, end: endIso, invited };
	} catch (error) {
		// Give the time back if the booking couldn't be finished.
		await db.prepare(`DELETE FROM bookings WHERE id = ? AND event_id IS NULL`).bind(bookingId).run();
		if (error instanceof CalendarError) throw new BookingError('calendar');
		throw error;
	}
}

export type OwnerNotice = {
	name: string;
	email: string;
	phone: string | null;
	note: string | null;
	answers: Answer[];
	guests: string[];
	start: number;
	end: number;
	previous?: { start: number; end: number };
	reason?: string | null;
	/** Who carried it out for the guest, when it wasn't the guest's own link ("Ava, from their email"). */
	via?: string | null;
};

/** Tells you about a booking, a move or a cancellation, from and to your own address; replying writes to the guest. */
export async function notifyOwner(
	db: D1Database,
	provider: EmailProvider,
	owner: User,
	page: BookingPage,
	what: 'booked' | 'rescheduled' | 'cancelled',
	booking: OwnerNotice
): Promise<void> {
	const from = await resolveFromAddress(db, owner, null, page.sendFrom);
	const when = formatWhen(booking.start, booking.end, page.timezone);
	// When someone did it for the guest, the guest didn't: name the booking, then who did it below.
	const head = booking.via
		? `"${page.title}" with ${booking.name} (${booking.email}) was ${what === 'booked' ? 'booked for' : what === 'rescheduled' ? 'moved to' : 'canceled on'} ${when}.`
		: what === 'booked'
			? `${booking.name} (${booking.email}) booked "${page.title}" for ${when}.`
			: what === 'rescheduled'
				? `${booking.name} (${booking.email}) moved "${page.title}" to ${when}.`
				: `${booking.name} (${booking.email}) canceled "${page.title}" on ${when}.`;
	const lines = [
		head,
		...(booking.previous ? [`It was ${formatWhen(booking.previous.start, booking.previous.end, page.timezone)}.`] : []),
		...(booking.via ? [`Done by ${booking.via}.`] : []),
		'',
		what === 'cancelled'
			? "It's off your calendar, and everyone invited was told."
			: what === 'rescheduled'
				? 'Your calendar is updated, and everyone invited got the new time.'
				: "It's on your calendar, and they were sent an invite.",
		...(booking.reason ? ['', 'Their reason:', booking.reason] : []),
		...(booking.phone ? ['', `Phone: ${booking.phone}`] : []),
		...(booking.guests.length ? ['', `Also invited: ${booking.guests.join(', ')}`] : []),
		...booking.answers.flatMap((answer) => ['', `${answer.label}`, answer.value]),
		...(booking.note ? ['', 'Their note:', booking.note] : []),
		'',
		'Reply to this email to write to them.'
	];
	const label = what === 'booked' ? 'New booking' : what === 'rescheduled' ? 'Rescheduled' : 'Canceled';
	await sendOutboundEmail(provider, {
		from,
		senderName: 'CloudMail booking',
		to: from.address,
		subject: `${label}: ${page.title} with ${booking.name}`.slice(0, 200),
		text: lines.join('\n'),
		headers: { 'Reply-To': booking.email, [APP_NOTICE_HEADER]: what }
	});
}
