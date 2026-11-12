import type { D1Database } from '@cloudflare/workers-types';
import type { Slot } from '#lib/calendar/availability.ts';
import { addDays, formatLocal, localToUtc, parseDate, utcToLocal } from '#lib/calendar/time.ts';
import type { User } from '#lib/types.ts';
import {
	BookingError,
	claimSends,
	guestKey,
	formatWhen,
	locationLabel,
	manageLine,
	manageUrl,
	newToken,
	notifyOwner,
	pageBySlug,
	slotsFor,
	tokenHash,
	type Answer,
	type PublicPage,
	publicPage
} from './booking-store.ts';
import { deleteEvent, seriesOf, updateEvent, type EventRow } from './calendar-store.ts';
import { listAttendees, sendInvites } from './calendar-invites.ts';
import type { EmailProvider } from './email-provider.ts';
import { resolveFromAddress } from './outbox.ts';
import { sendOutboundEmail } from './send-mail.ts';
import { fromDomainVerified, parseSecurity } from '#lib/security/phishing.ts';

/**
 * The guest's side of a booking: a private link (/book/manage#<token>) to
 * reschedule or cancel, and a reminder before the meeting. Only the booker's
 * own invite carries the link; only its hash is stored, and it changes each
 * time the meeting moves. Once you change the meeting yourself, the link
 * stops working and the guest is asked to reply to you instead.
 */

type BookingRow = {
	id: string;
	page_id: string;
	user_id: string;
	event_id: string | null;
	guest_name: string;
	guest_email: string;
	guest_phone: string | null;
	note: string | null;
	answers_json: string;
	extra_guests_json: string;
	guest_timezone: string | null;
	start_at: string;
	end_at: string;
	status: string;
	reschedule_count: number;
	reminder_sent_at: string | null;
	manage_token_hash: string | null;
	slug: string;
	max_per_day: number;
	page_timezone: string;
};

/** Each booking can move twice; after that, the guest writes to you. */
export const MAX_RESCHEDULES = 2;
const HOLD_MS = 2 * 60_000;

async function byToken(db: D1Database, token: unknown): Promise<BookingRow | null> {
	if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,64}$/.test(token)) return null;
	return db
		.prepare(
			`SELECT b.*, p.slug, p.max_per_day, p.timezone AS page_timezone
			 FROM bookings b JOIN booking_pages p ON p.id = b.page_id WHERE b.manage_token_hash = ?`
		)
		.bind(await tokenHash(token))
		.first<BookingRow>();
}

function answersOf(row: BookingRow): Answer[] {
	try {
		return JSON.parse(row.answers_json) as Answer[];
	} catch {
		return [];
	}
}

function guestsOf(row: BookingRow): string[] {
	try {
		return JSON.parse(row.extra_guests_json) as string[];
	} catch {
		return [];
	}
}

/**
 * The event is still the meeting that was booked: one-off, at the booked time,
 * with no one the guest didn't invite. Otherwise you've made it yours, and the
 * guest's link no longer changes it.
 */
async function bookedEvent(db: D1Database, row: BookingRow): Promise<EventRow | null> {
	if (!row.event_id) return null;
	let series: EventRow;
	try {
		series = await seriesOf(db, row.user_id, row.event_id);
	} catch {
		return null;
	}
	if (series.id !== row.event_id || series.rrule || series.parent_id) return null;
	if (series.start_at !== row.start_at || series.end_at !== row.end_at) return null;
	const allowed = new Set([row.guest_email, ...guestsOf(row)].map((email) => email.toLowerCase()));
	const attendees = await listAttendees(db, series.id);
	if (attendees.some((guest) => !allowed.has(guest.email.toLowerCase()))) return null;
	return series;
}

export type ManageView = {
	page: PublicPage;
	booking: {
		name: string;
		start: string;
		end: string;
		duration: number;
		/** changed: the host changed the meeting, so the guest should reply to them. */
		status: 'confirmed' | 'cancelled' | 'changed';
		canChange: boolean;
		canReschedule: boolean;
	};
};

async function statusOf(db: D1Database, row: BookingRow): Promise<'confirmed' | 'cancelled' | 'changed'> {
	if (row.status !== 'confirmed' || !row.event_id) return 'cancelled';
	return (await bookedEvent(db, row)) ? 'confirmed' : 'changed';
}

export async function manageView(db: D1Database, token: unknown, now = new Date()): Promise<ManageView | null> {
	const row = await byToken(db, token);
	if (!row) return null;
	const page = await publicPage(db, row.slug, true);
	if (!page) return null;
	const start = Date.parse(row.start_at);
	const end = Date.parse(row.end_at);
	const status = await statusOf(db, row);
	const canChange = status === 'confirmed' && start > now.getTime();
	return {
		page,
		booking: {
			name: row.guest_name,
			start: row.start_at,
			end: row.end_at,
			duration: Math.round((end - start) / 60_000),
			status,
			canChange,
			canReschedule: canChange && row.reschedule_count < MAX_RESCHEDULES
		}
	};
}

async function ownerOf(db: D1Database, row: { user_id: string }): Promise<User> {
	const owner = await db.prepare(`SELECT * FROM users WHERE id = ?`).bind(row.user_id).first<User>();
	if (!owner) throw new BookingError('missing');
	return owner;
}

/** A booking the guest may still change, and its event. */
async function changeable(db: D1Database, token: unknown, now: Date): Promise<{ row: BookingRow; event: EventRow }> {
	const row = await byToken(db, token);
	if (!row) throw new BookingError('missing');
	if (row.status !== 'confirmed' || !row.event_id) throw new BookingError('cancelled');
	if (Date.parse(row.start_at) <= now.getTime()) throw new BookingError('past');
	const event = await bookedEvent(db, row);
	if (!event) throw new BookingError('changed');
	return { row, event };
}

/** Open times to move this meeting to: same length, and its own time doesn't block itself. */
export async function manageSlots(
	db: D1Database,
	token: unknown,
	input: { from: number; to: number },
	now = new Date()
): Promise<Slot[]> {
	const { row } = await changeable(db, token, now);
	return openFor(db, row, input, now);
}

export async function cancelBooking(
	db: D1Database,
	provider: EmailProvider | null,
	token: unknown,
	reason: unknown,
	now = new Date()
): Promise<void> {
	const { row, event } = await changeable(db, token, now);
	await cancelCore(db, provider, row, event, reason, now, null);
}

/** Cancels a booking that may still be changed. `via`: an agent acting on the guest's email, named in your note. */
async function cancelCore(
	db: D1Database,
	provider: EmailProvider | null,
	row: BookingRow,
	event: EventRow,
	reason: unknown,
	now: Date,
	via: string | null
): Promise<void> {
	const why = typeof reason === 'string' ? reason.trim().slice(0, 500) || null : null;
	// Claim it, so two clicks don't cancel twice.
	const claim = await db
		.prepare(
			`UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancel_reason = ? WHERE id = ? AND status = 'confirmed'`
		)
		.bind(now.toISOString(), why, row.id)
		.run();
	if (!claim.meta.changes) throw new BookingError('cancelled');

	const owner = await ownerOf(db, row);
	const attendees = await listAttendees(db, event.id);
	try {
		await deleteEvent(db, row.user_id, event.id, undefined, now);
	} catch (error) {
		// Still on the calendar: the booking stays too, so it can be canceled again.
		await db
			.prepare(`UPDATE bookings SET status = 'confirmed', cancelled_at = NULL, cancel_reason = NULL WHERE id = ?`)
			.bind(row.id)
			.run();
		throw error;
	}
	// Telling everyone counts against the page's day; past the limit, only you are told.
	if (provider && attendees.length && (await claimSends(db, row.page_id, row.id, 'cancelled', attendees.length, now))) {
		await sendInvites(db, provider, owner, event, { cancelAll: true, attendees, edits: [] }).catch((error) =>
			console.error('Booking cancellation failed to send', row.id, error instanceof Error ? error.message : 'unknown')
		);
	}
	const page = await pageBySlug(db, row.slug, true);
	if (provider && page) {
		await notifyOwner(db, provider, owner, page, 'cancelled', {
			name: row.guest_name,
			email: row.guest_email,
			phone: row.guest_phone,
			note: null,
			answers: [],
			guests: guestsOf(row),
			start: Date.parse(row.start_at),
			end: Date.parse(row.end_at),
			reason: why,
			via
		}).catch((error) => console.error('Booking cancel notice failed', row.id, error instanceof Error ? error.message : 'unknown'));
	}
}

export async function rescheduleBooking(
	db: D1Database,
	provider: EmailProvider | null,
	token: unknown,
	startInput: unknown,
	options: { origin: string; now?: Date }
): Promise<{ start: string; end: string; manageUrl: string }> {
	const now = options.now ?? new Date();
	const { row, event } = await changeable(db, token, now);
	const moved = await moveCore(db, provider, row, event, startInput, { origin: options.origin, now, limit: MAX_RESCHEDULES, via: null });
	return { start: moved.start, end: moved.end, manageUrl: manageUrl(options.origin, moved.token!) };
}

/**
 * Moves a booking that may still be changed to an open time of the same
 * length. With an origin, the guest's link changes and their updated invite
 * carries the new one; without, the old link keeps working.
 */
async function moveCore(
	db: D1Database,
	provider: EmailProvider | null,
	row: BookingRow,
	event: EventRow,
	startInput: unknown,
	options: { origin: string | null; now: Date; limit: number; via: string | null }
): Promise<{ start: string; end: string; token: string | null }> {
	const { now } = options;
	if (row.reschedule_count >= options.limit) throw new BookingError('too_many');
	const start = typeof startInput === 'string' ? Date.parse(startInput) : NaN;
	if (!Number.isFinite(start)) throw new BookingError('taken');
	const previous = { start: Date.parse(row.start_at), end: Date.parse(row.end_at) };
	const end = start + (previous.end - previous.start);
	const open = await openFor(db, row, { from: start - 86_400_000, to: end + 86_400_000 }, now);
	const slot = open.find((item) => item.start === start);
	if (!slot) throw new BookingError('taken');
	const attendees = await listAttendees(db, event.id);
	// Everyone gets the new time, so it counts against the page's day.
	if (!(await claimSends(db, row.page_id, row.id, 'rescheduled', attendees.length, now))) throw new BookingError('slow_down');

	const startIso = new Date(start).toISOString();
	const endIso = new Date(end).toISOString();
	const dayStart = new Date(localToUtc({ ...parseDate(slot.date)!, hour: 0, minute: 0 }, row.page_timezone)).toISOString();
	const dayEnd = new Date(localToUtc({ ...addDays(parseDate(slot.date)!, 1), hour: 0, minute: 0 }, row.page_timezone)).toISOString();
	const holdCutoff = new Date(now.getTime() - HOLD_MS).toISOString();
	// A new link: the old one (in the old invite) stops working.
	const token = options.origin ? newToken() : null;
	const nextHash = token ? await tokenHash(token) : row.manage_token_hash;
	// Moved in one statement, so it can't land on a time another booking just took, or a full day.
	const moved = await db
		.prepare(
			`UPDATE bookings SET start_at = ?, end_at = ?, reschedule_count = reschedule_count + 1, reminder_sent_at = NULL,
			   manage_token_hash = ?
			 WHERE id = ? AND status = 'confirmed' AND reschedule_count < ?
			   AND NOT EXISTS (
			     SELECT 1 FROM bookings o WHERE o.user_id = ? AND o.id <> ? AND o.status = 'confirmed'
			       AND o.start_at < ? AND o.end_at > ? AND (o.event_id IS NOT NULL OR o.created_at > ?)
			   )
			   AND (SELECT COUNT(*) FROM bookings d WHERE d.page_id = ? AND d.id <> ? AND d.status = 'confirmed'
			          AND d.start_at >= ? AND d.start_at < ? AND (d.event_id IS NOT NULL OR d.created_at > ?)) < ?`
		)
		.bind(
			startIso,
			endIso,
			nextHash,
			row.id,
			options.limit,
			row.user_id,
			row.id,
			endIso,
			startIso,
			holdCutoff,
			row.page_id,
			row.id,
			dayStart,
			dayEnd,
			holdCutoff,
			row.max_per_day
		)
		.run();
	if (!moved.meta.changes) throw new BookingError('taken');

	const owner = await ownerOf(db, row);
	const local = (ms: number) => formatLocal(utcToLocal(ms, event.timezone));
	try {
		await updateEvent(db, row.user_id, event.id, { start: local(start), end: local(end), timezone: event.timezone }, now);
	} catch (error) {
		// The calendar didn't follow: put the booking back as it was, old link included.
		await db
			.prepare(
				`UPDATE bookings SET start_at = ?, end_at = ?, reschedule_count = reschedule_count - 1, reminder_sent_at = ?,
				   manage_token_hash = ? WHERE id = ?`
			)
			.bind(row.start_at, row.end_at, row.reminder_sent_at, row.manage_token_hash, row.id)
			.run();
		throw error instanceof BookingError ? error : new BookingError('calendar');
	}
	if (provider) {
		try {
			await sendInvites(db, provider, owner, await seriesOf(db, row.user_id, event.id), {
				privateLines: token && options.origin ? { [row.guest_email]: manageLine(options.origin, token) } : {}
			});
		} catch (error) {
			console.error('Booking update failed to send', row.id, error instanceof Error ? error.message : 'unknown');
		}
	}
	const page = await pageBySlug(db, row.slug, true);
	if (provider && page) {
		await notifyOwner(db, provider, owner, page, 'rescheduled', {
			name: row.guest_name,
			email: row.guest_email,
			phone: row.guest_phone,
			note: row.note,
			answers: answersOf(row),
			guests: guestsOf(row),
			start,
			end,
			previous,
			via: options.via
		}).catch((error) => console.error('Booking move notice failed', row.id, error instanceof Error ? error.message : 'unknown'));
	}
	return { start: startIso, end: endIso, token };
}

/** Open times for a booking's own length, its own time not blocking itself. */
async function openFor(db: D1Database, row: BookingRow, input: { from: number; to: number }, now: Date): Promise<Slot[]> {
	const page = await pageBySlug(db, row.slug, true);
	if (!page) throw new BookingError('missing');
	const duration = Math.round((Date.parse(row.end_at) - Date.parse(row.start_at)) / 60_000);
	const withLength = { ...page, durations: [...new Set([...page.durations, duration])] };
	return slotsFor(db, withLength, { ...input, duration }, now, row.event_id);
}

// ---------------------------------------------------------------------------
// An agent acting on the guest's own email (Ava)

/**
 * Moves a guest may ask for by email, in all: two more than the link allows,
 * since an agent reading their words is the fallback when the link is used up.
 */
export const MAX_AGENT_RESCHEDULES = MAX_RESCHEDULES + 2;

/** A booking as an agent sees it: enough to act on, nothing private beyond what the guest gave. */
export type GuestBooking = {
	id: string;
	page: string;
	timezone: string;
	start: string;
	end: string;
	duration: number;
	guestTimezone: string | null;
	canReschedule: boolean;
	/** Open times to move it to, same length, the next two weeks. */
	openTimes: string[];
};

/** At most `perDay` open times a day, spread from morning to evening. */
/**
 * Whether a booking can move to exactly this time, for an agent about to propose
 * it: the list it's shown is a sample, so a time a guest asks for may be open
 * without being listed. When it isn't, the nearest open times, closest first.
 */
export async function checkMoveTime(
	db: D1Database,
	userId: string,
	bookingId: string,
	start: unknown,
	now = new Date()
): Promise<{ open: true } | { open: false; nearest: Array<{ start: string; label: string }> }> {
	const row = await db
		.prepare(
			`SELECT b.*, p.slug, p.max_per_day, p.timezone AS page_timezone
			 FROM bookings b JOIN booking_pages p ON p.id = b.page_id
			 WHERE b.id = ? AND b.user_id = ? AND b.status = 'confirmed'`
		)
		.bind(bookingId, userId)
		.first<BookingRow>();
	const at = typeof start === 'string' ? Date.parse(start) : NaN;
	if (!row || !Number.isFinite(at)) return { open: false, nearest: [] };
	const day = 86_400_000;
	const open = await openFor(db, row, { from: Math.max(now.getTime(), at - 3 * day), to: at + 3 * day }, now);
	if (open.some((slot) => slot.start === at)) return { open: true };
	const label = new Intl.DateTimeFormat('en-US', {
		timeZone: row.page_timezone,
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
		timeZoneName: 'short'
	});
	const nearest = [...open]
		.sort((a, b) => Math.abs(a.start - at) - Math.abs(b.start - at))
		.slice(0, 4)
		.map((slot) => ({ start: new Date(slot.start).toISOString(), label: label.format(new Date(slot.start)) }));
	return { open: false, nearest };
}

function spread(slots: Slot[], perDay: number): Slot[] {
	const byDay = new Map<string, Slot[]>();
	for (const slot of slots) byDay.set(slot.date, [...(byDay.get(slot.date) ?? []), slot]);
	const out: Slot[] = [];
	for (const day of byDay.values()) {
		if (day.length <= perDay) out.push(...day);
		else for (let i = 0; i < perDay; i++) out.push(day[Math.round((i * (day.length - 1)) / (perDay - 1))]);
	}
	return out;
}

/**
 * Who may act on a booking by email: the exact address that booked. Gmail is
 * the one exception, where dots and +tags reach the same mailbox.
 */
function identity(email: string): { column: 'guest_key' | 'guest_email'; value: string } {
	const address = email.trim().toLowerCase();
	const domain = address.split('@').pop();
	return domain === 'gmail.com' || domain === 'googlemail.com'
		? { column: 'guest_key', value: guestKey(address) }
		: { column: 'guest_email', value: address };
}

/** Upcoming bookings this person made on pages that send from one of `sendFrom` (the agent's addresses). */
async function guestRows(db: D1Database, userId: string, guestEmail: string, sendFrom: string[], now: Date): Promise<BookingRow[]> {
	if (sendFrom.length === 0) return [];
	const who = identity(guestEmail);
	const { results } = await db
		.prepare(
			`SELECT b.*, p.slug, p.max_per_day, p.timezone AS page_timezone, p.title AS page_title
			 FROM bookings b JOIN booking_pages p ON p.id = b.page_id
			 WHERE b.user_id = ? AND b.status = 'confirmed' AND b.event_id IS NOT NULL AND b.start_at > ?
			   AND lower(b.${who.column}) = ? AND lower(p.send_from) IN (SELECT value FROM json_each(?))
			 ORDER BY b.start_at LIMIT 5`
		)
		.bind(userId, now.toISOString(), who.value, JSON.stringify(sendFrom.map((a) => a.toLowerCase())))
		.all<BookingRow & { page_title: string }>();
	return results;
}

/**
 * What an agent may know about the sender's bookings, for a reply it's
 * handling. Empty unless the mail provably comes from that address (DMARC
 * pass, not flagged as phishing): a forged "please cancel" can't move anyone's meeting.
 */
export async function bookingsForGuest(
	db: D1Database,
	userId: string,
	email: { from_addr: string; security_json: string | null },
	sendFrom: string[],
	now = new Date(),
	/** A teammate asked about this mail, so they vouch it's from the guest. */
	vouched = false
): Promise<GuestBooking[]> {
	if (!vouched && !senderVerified(email.security_json, email.from_addr)) return [];
	const out: GuestBooking[] = [];
	for (const row of await guestRows(db, userId, email.from_addr, sendFrom, now)) {
		if (!(await bookedEvent(db, row))) continue;
		const start = Date.parse(row.start_at);
		const end = Date.parse(row.end_at);
		const canReschedule = row.reschedule_count < MAX_AGENT_RESCHEDULES;
		const open = canReschedule ? await openFor(db, row, { from: now.getTime(), to: now.getTime() + 14 * 86_400_000 }, now) : [];
		out.push({
			id: row.id,
			page: (row as BookingRow & { page_title?: string }).page_title ?? row.slug,
			timezone: row.page_timezone,
			start: row.start_at,
			end: row.end_at,
			duration: Math.round((end - start) / 60_000),
			guestTimezone: row.guest_timezone,
			canReschedule,
			// Spread over the two weeks, a handful a day, so the prompt stays small.
			openTimes: spread(open, 6).slice(0, 60).map((slot) => new Date(slot.start).toISOString())
		});
	}
	return out;
}

/**
 * The sender's own domain proved the mail is theirs (DMARC passed, for that
 * domain), and it isn't flagged as phishing or suspicious.
 */
export function senderVerified(securityJson: string | null, fromAddress: string): boolean {
	const security = parseSecurity(securityJson);
	return !!security && security.verdict === null && fromDomainVerified(security.auth, fromAddress);
}

/**
 * An agent moving or canceling a booking for the guest who emailed. Checked
 * again here, whatever the model said: the booking is the sender's own, on a
 * page the agent sends from, unchanged by the host, and the mail is verified.
 */
export async function agentBookingChange(
	db: D1Database,
	provider: EmailProvider | null,
	input: {
		userId: string;
		bookingId: string;
		email: { from_addr: string; security_json: string | null };
		sendFrom: string[];
		agentName: string;
		op: 'reschedule' | 'cancel';
		start?: unknown;
		reason?: unknown;
		/** Who asked the agent to do this, when a teammate did; they vouch for the mail. */
		askedBy?: string | null;
	},
	now = new Date()
): Promise<{ start: string; end: string } | null> {
	if (!input.askedBy && !senderVerified(input.email.security_json, input.email.from_addr)) throw new BookingError('not_verified');
	const row = (await guestRows(db, input.userId, input.email.from_addr, input.sendFrom, now)).find((item) => item.id === input.bookingId);
	if (!row) throw new BookingError('missing');
	const event = await bookedEvent(db, row);
	if (!event) throw new BookingError('changed');
	const via = input.askedBy ? `${input.agentName}, asked by ${input.askedBy}` : `${input.agentName}, from their email`;
	if (input.op === 'cancel') {
		await cancelCore(db, provider, row, event, input.reason, now, via);
		return null;
	}
	const origin = await db.prepare(`SELECT site_origin FROM booking_pages WHERE id = ?`).bind(row.page_id).first<{ site_origin: string | null }>();
	const moved = await moveCore(db, provider, row, event, input.start, {
		origin: origin?.site_origin ?? null,
		now,
		limit: MAX_AGENT_RESCHEDULES,
		via
	});
	return { start: moved.start, end: moved.end };
}

type ReminderRow = BookingRow & {
	reminder_minutes: number;
	title: string;
	send_from: string | null;
	location: string | null;
	created_at: string;
	location_kind: string | null;
	location_label: string | null;
	page_location: string | null;
};

/**
 * Reminders that are due: from your own address, so a reply ("running late")
 * lands in your inbox. Bookings made inside the reminder window don't get one;
 * their invite is fresh. Meetings you've changed yourself don't either.
 */
export async function sendDueReminders(db: D1Database, provider: EmailProvider, now = new Date(), limit = 20): Promise<number> {
	const at = now.toISOString();
	const { results } = await db
		.prepare(
			`SELECT b.*, p.slug, p.max_per_day, p.timezone AS page_timezone, p.reminder_minutes, p.title, p.send_from,
			        p.location_kind, p.location_label, p.location AS page_location, e.location
			 FROM bookings b
			 JOIN booking_pages p ON p.id = b.page_id
			 JOIN calendar_events e ON e.id = b.event_id
			 WHERE b.status = 'confirmed' AND b.reminder_sent_at IS NULL AND p.reminder_minutes > 0
			   AND b.start_at > ? AND b.start_at <= strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+' || p.reminder_minutes || ' minutes')
			   AND e.start_at = b.start_at
			 ORDER BY b.start_at
			 LIMIT ?`
		)
		.bind(at, at, limit)
		.all<ReminderRow>();
	let sent = 0;
	for (const row of results) {
		const claim = await db
			.prepare(`UPDATE bookings SET reminder_sent_at = ? WHERE id = ? AND reminder_sent_at IS NULL`)
			.bind(at, row.id)
			.run();
		if (!claim.meta.changes) continue;
		const start = Date.parse(row.start_at);
		const end = Date.parse(row.end_at);
		if (start - Date.parse(row.created_at) < row.reminder_minutes * 60_000) continue;
		// You took a thread with this guest over (or an agent handed it to you): nothing automatic
		// goes to them, not even a reminder, unless you turned reminders back on for it (R15).
		const held = await db
			.prepare(
				`SELECT 1 AS yes FROM thread_takeovers t
				 JOIN emails e ON e.user_id = t.mailbox_user_id AND coalesce(e.thread_id, e.id) = t.thread_id
				 WHERE t.mailbox_user_id = ? AND t.reminders = 0 AND e.direction = 'inbound' AND lower(e.from_addr) = ?
				 LIMIT 1`
			)
			.bind(row.user_id, row.guest_email.toLowerCase())
			.first<{ yes: number }>();
		if (held) continue;
		try {
			const owner = await ownerOf(db, row);
			const from = await resolveFromAddress(db, owner, null, row.send_from);
			const zone = row.guest_timezone ?? row.page_timezone;
			const host = owner.name?.trim() || from.address;
			const where = locationLabel({
				locationKind: (row.location_kind ?? 'none') as never,
				location: row.page_location,
				locationText: row.location_label,
				hostName: host
			});
			const lines = [
				`Hi ${row.guest_name},`,
				'',
				`A reminder of your meeting with ${host}:`,
				'',
				row.title,
				formatWhen(start, end, zone),
				...(row.location ? [`Where: ${row.location}`] : where ? [`Where: ${where.label}`] : []),
				'',
				'To reschedule or cancel, use the link in your invitation email, or reply to this one.'
			];
			await sendOutboundEmail(provider, {
				from,
				senderName: owner.name || from.address,
				to: row.guest_email,
				subject: `Reminder: ${row.title}, ${formatWhen(start, end, zone)}`.slice(0, 200),
				text: lines.join('\n')
			});
			sent++;
		} catch (error) {
			console.error('Booking reminder failed', row.id, error instanceof Error ? error.message : 'unknown');
		}
	}
	return sent;
}

export type BookingDetails = {
	page: string;
	name: string;
	email: string;
	phone: string | null;
	note: string | null;
	answers: Answer[];
	guests: string[];
	rescheduled: number;
};

/** For the owner's event editor: who booked it and what they said. */
export async function bookingForEvent(db: D1Database, userId: string, eventId: string): Promise<BookingDetails | null> {
	const row = await db
		.prepare(
			`SELECT b.*, p.title AS page_title, p.slug FROM bookings b JOIN booking_pages p ON p.id = b.page_id
			 WHERE b.event_id = ? AND b.user_id = ? ORDER BY b.created_at DESC LIMIT 1`
		)
		.bind(eventId, userId)
		.first<BookingRow & { page_title: string }>();
	if (!row) return null;
	return {
		page: row.page_title,
		name: row.guest_name,
		email: row.guest_email,
		phone: row.guest_phone,
		note: row.note,
		answers: answersOf(row),
		guests: guestsOf(row),
		rescheduled: row.reschedule_count
	};
}
