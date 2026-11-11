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
};

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
		enabled: row.enabled === 1
	};
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
	const location = input.location === undefined ? (current?.location ?? null) : readText(input.location, 500);

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
		enabled: input.enabled === undefined ? (current?.enabled ?? true) : input.enabled === true
	};
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
				   min_notice_minutes, horizon_days, max_per_day, calendar_id, send_from, location, enabled, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
				at
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
				   location = ?, enabled = ?, updated_at = ?
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
	location: string | null;
	host: string;
};

async function pageBySlug(db: D1Database, slug: string): Promise<(BookingPage & { userId: string; hostName: string }) | null> {
	if (!/^[a-z0-9-]{3,40}$/.test(slug)) return null;
	const row = await db
		.prepare(
			`SELECT p.*, u.name AS host_name FROM booking_pages p JOIN users u ON u.id = p.user_id
			 WHERE p.slug = ? AND p.enabled = 1`
		)
		.bind(slug)
		.first<PageRow & { host_name: string | null }>();
	if (!row) return null;
	return { ...toPage(row), userId: row.user_id, hostName: row.host_name?.trim() || 'Your host' };
}

/** What a visitor sees: no hours, calendars or addresses, just enough to pick a time. */
export async function publicPage(db: D1Database, slug: string): Promise<PublicPage | null> {
	const page = await pageBySlug(db, slug);
	if (!page) return null;
	return {
		slug: page.slug,
		title: page.title,
		description: page.description,
		durations: page.durations,
		timezone: page.timezone,
		location: page.location,
		host: page.hostName
	};
}

/** Everything that blocks time for this person: every calendar, outside ones included, plus held slots. */
async function busyFor(db: D1Database, userId: string, from: number, to: number, now: Date): Promise<Interval[]> {
	const calendars = await listCalendars(db, userId);
	const occurrences = await occurrencesInRange(db, calendars, from, to);
	const busy: Interval[] = occurrences
		.filter((item) => item.transparency === 'busy' && item.myStatus !== 'declined')
		.map((item) => ({ start: Date.parse(item.start), end: Date.parse(item.end) }));
	// A booking still being written (its event isn't there yet) holds its time for a couple of minutes.
	const { results } = await db
		.prepare(
			`SELECT start_at, end_at FROM bookings
			 WHERE user_id = ? AND event_id IS NULL AND created_at > ? AND start_at < ? AND end_at > ?`
		)
		.bind(userId, new Date(now.getTime() - HOLD_MS).toISOString(), new Date(to).toISOString(), new Date(from).toISOString())
		.all<{ start_at: string; end_at: string }>();
	for (const row of results) busy.push({ start: Date.parse(row.start_at), end: Date.parse(row.end_at) });
	return busy;
}

const HOLD_MS = 2 * 60_000;

async function bookedPerDay(db: D1Database, page: BookingPage, from: number, to: number, now: Date): Promise<Record<string, number>> {
	const { results } = await db
		.prepare(
			`SELECT start_at FROM bookings WHERE page_id = ? AND start_at >= ? AND start_at < ?
			   AND (event_id IS NOT NULL OR created_at > ?)`
		)
		.bind(page.id, new Date(from - 86_400_000).toISOString(), new Date(to + 86_400_000).toISOString(), new Date(now.getTime() - HOLD_MS).toISOString())
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

/** At most two weeks of slots per request. */
const MAX_WINDOW_MS = 15 * 86_400_000;

export async function openSlots(
	db: D1Database,
	slug: string,
	input: { from: number; to: number; duration: number },
	now = new Date()
): Promise<Slot[]> {
	const page = await pageBySlug(db, slug);
	if (!page) throw new BookingError('missing');
	if (!page.durations.includes(input.duration)) throw new BookingError('durations');
	const from = Math.max(input.from, now.getTime());
	const to = Math.min(input.to, from + MAX_WINDOW_MS, now.getTime() + page.horizonDays * 86_400_000);
	if (!(to > from)) return [];
	const pad = (page.bufferMinutes + 24 * 60) * 60_000;
	const busy = await busyFor(db, page.userId, from - pad, to + pad, now);
	return freeSlots({
		rules: rulesOf(page, input.duration),
		busy,
		booked: await bookedPerDay(db, page, from, to, now),
		from,
		to,
		now: now.getTime()
	});
}

const EMAIL = /^[^\s@,;<>"()\[\]\\]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/** A guest's name as it may appear in an invite: letters, spaces and a little punctuation. */
export function cleanName(value: unknown): string {
	if (typeof value !== 'string') throw new BookingError('name');
	const name = value
		.normalize('NFKC')
		.replace(/[^\p{L}\p{M}\s.'’-]/gu, '')
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
const AHEAD_PER_GUEST = 3;

export type BookingResult = { start: string; end: string; invited: boolean };

/**
 * Books a slot. The time is checked again here, a short hold stops two people
 * taking it at once, and limits keep the page from being used to flood your
 * calendar or someone's inbox.
 */
export async function bookSlot(
	db: D1Database,
	provider: EmailProvider | null,
	slug: string,
	input: { start: unknown; duration: unknown; name: unknown; email: unknown; note: unknown },
	options: { uidDomain: string; now?: Date }
): Promise<BookingResult> {
	const now = options.now ?? new Date();
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

	const key = guestKey(email);
	const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
	const holdCutoff = new Date(now.getTime() - HOLD_MS).toISOString();
	// No more than a handful of bookings an hour from one page, and three ahead per guest.
	// Checked here for a clear answer, and again inside the hold so parallel tries can't pass.
	const limits = async () => {
		const recent = await db
			.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE page_id = ? AND created_at > ?`)
			.bind(page.id, hourAgo)
			.first<{ n: number }>();
		if ((recent?.n ?? 0) >= PER_HOUR) throw new BookingError('slow_down');
		const ahead = await db
			.prepare(
				`SELECT COUNT(*) AS n FROM bookings WHERE page_id = ? AND guest_key = ? AND start_at > ?
				   AND (event_id IS NOT NULL OR created_at > ?)`
			)
			.bind(page.id, key, now.toISOString(), holdCutoff)
			.first<{ n: number }>();
		if ((ahead?.n ?? 0) >= AHEAD_PER_GUEST) throw new BookingError('too_many');
	};
	await limits();

	const end = start + duration * 60_000;
	const day = 86_400_000;
	const open = await openSlots(db, slug, { from: start - day, to: end + day, duration }, now);
	if (!open.some((slot) => slot.start === start)) throw new BookingError('taken');

	// The hold: one statement, so a second booking for an overlapping time can't slip in.
	const bookingId = crypto.randomUUID();
	const startIso = new Date(start).toISOString();
	const endIso = new Date(end).toISOString();
	const slot = open.find((item) => item.start === start)!;
	const dayStart = localToUtc({ ...parseDate(slot.date)!, hour: 0, minute: 0 }, page.timezone);
	const dayEnd = localToUtc({ ...addDays(parseDate(slot.date)!, 1), hour: 0, minute: 0 }, page.timezone);
	const hold = await db
		.prepare(
			`INSERT INTO bookings (id, page_id, user_id, guest_name, guest_email, guest_key, note, start_at, end_at, created_at)
			 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
			 WHERE NOT EXISTS (
			   SELECT 1 FROM bookings WHERE user_id = ? AND start_at < ? AND end_at > ?
			     AND (event_id IS NOT NULL OR created_at > ?)
			 )
			 AND (SELECT COUNT(*) FROM bookings WHERE page_id = ? AND created_at > ?) < ?
			 AND (SELECT COUNT(*) FROM bookings WHERE page_id = ? AND guest_key = ? AND start_at > ?
			        AND (event_id IS NOT NULL OR created_at > ?)) < ?
			 AND (SELECT COUNT(*) FROM bookings WHERE page_id = ? AND start_at >= ? AND start_at < ?
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
			page.userId,
			endIso,
			startIso,
			holdCutoff,
			page.id,
			hourAgo,
			PER_HOUR,
			page.id,
			key,
			now.toISOString(),
			holdCutoff,
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
				description: `Booked through your booking page by ${name} (${email}).`,
				location: page.location,
				start: local(start),
				end: local(end),
				timezone: page.timezone
			},
			{ now, uidDomain: options.uidDomain }
		);
		await db.prepare(`UPDATE bookings SET event_id = ? WHERE id = ?`).bind(eventId, bookingId).run();
		await setSendFrom(db, eventId, page.sendFrom);
		await replaceAttendees(db, eventId, [{ email, name }]);

		let invited = false;
		if (provider) {
			const series = await seriesOf(db, page.userId, eventId);
			const result = await sendInvites(db, provider, owner, series).catch((error) => {
				console.error('Booking invite failed', bookingId, error);
				return { sent: 0, error: 'send' };
			});
			invited = result.sent > 0;
			await notifyOwner(db, provider, owner, page, { name, email, note, start, end }).catch((error) =>
				console.error('Booking notice failed', bookingId, error)
			);
		}
		return { start: startIso, end: endIso, invited };
	} catch (error) {
		// Give the time back if the booking couldn't be finished.
		await db.prepare(`DELETE FROM bookings WHERE id = ? AND event_id IS NULL`).bind(bookingId).run();
		if (error instanceof CalendarError) throw new BookingError('calendar');
		throw error;
	}
}

/** Tells you about the booking, from and to your own address; replying writes to the guest. */
async function notifyOwner(
	db: D1Database,
	provider: EmailProvider,
	owner: User,
	page: BookingPage,
	booking: { name: string; email: string; note: string | null; start: number; end: number }
): Promise<void> {
	const from = await resolveFromAddress(db, owner, null, page.sendFrom);
	const when = new Intl.DateTimeFormat('en-US', {
		timeZone: page.timezone,
		weekday: 'long',
		month: 'long',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
		timeZoneName: 'short'
	}).format(new Date(booking.start));
	const lines = [
		`${booking.name} (${booking.email}) booked "${page.title}" for ${when}.`,
		'',
		"It's on your calendar, and they were sent an invite.",
		...(booking.note ? ['', 'Their note:', booking.note] : []),
		'',
		'Reply to this email to write to them.'
	];
	await sendOutboundEmail(provider, {
		from,
		senderName: 'CloudMail booking',
		to: from.address,
		subject: `New booking: ${page.title} with ${booking.name}`.slice(0, 200),
		text: lines.join('\n'),
		headers: { 'Reply-To': booking.email }
	});
}
