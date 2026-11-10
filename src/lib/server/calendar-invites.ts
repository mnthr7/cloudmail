import type { D1Database } from '@cloudflare/workers-types';
import {
	calendarFile,
	cleanPartstat,
	declineCounterFile,
	peopleLines,
	replyFile,
	type IcsEvent,
	type InviteAttendee
} from '#lib/calendar/ics.ts';
import { groupByUid, parseCalendar, type ParsedAttendee, type ParsedEvent } from '#lib/calendar/ics-parse.ts';
import { describeRule, parseRule } from '#lib/calendar/recurrence.ts';
import { localToUtc, parseDate, parseLocal } from '#lib/calendar/time.ts';
import type { AttendeeView, InviteView } from '#lib/calendar/types.ts';

export type { InviteView } from '#lib/calendar/types.ts';
import { parseSecurity } from '#lib/security/phishing.ts';
import type { MailAddress, User } from '#lib/types.ts';
import { humanPrincipalForUser } from './agents-store.ts';
import {
	CalendarError,
	editedOccurrences,
	ensureCalendars,
	eventsByUid,
	seriesOf,
	updateEvent,
	upsertImportedEvent,
	type EventRow
} from './calendar-store.ts';
import type { EmailProvider } from './email-provider.ts';
import { setThreadColumns } from './organizing-store.ts';
import { resolveFromAddress } from './outbox.ts';
import { sendOutboundEmail } from './send-mail.ts';

/**
 * Invites (calendar step 2). Events you organize have guests who get real
 * iCalendar invites by email (iMIP: REQUEST, CANCEL), and their RSVPs come back
 * as REPLY mail. Invites others send you are kept with the email they came in;
 * answering one puts it on your calendar and sends your RSVP to the organizer.
 *
 * Mail is untrusted: an update or cancellation only changes an event you
 * already accepted when it comes from that event's organizer and DMARC didn't
 * fail, and a reply only counts for the guest who sent it.
 */

export const MAX_GUESTS = 50;
const ADDRESS = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

export type Guest = { email: string; name: string | null };

/** Guests from the editor: addresses (with optional names), cleaned, without you. */
export function readGuests(value: unknown, own: string[]): Guest[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw new CalendarError('text');
	const skip = new Set(own.map((address) => address.toLowerCase()));
	const out = new Map<string, Guest>();
	for (const item of value.slice(0, MAX_GUESTS + 10)) {
		const raw = typeof item === 'string' ? { email: item, name: null } : (item as { email?: unknown; name?: unknown });
		const email = typeof raw?.email === 'string' ? raw.email.trim().toLowerCase() : '';
		if (!ADDRESS.test(email) || email.length > 254) throw new CalendarError('guests');
		if (skip.has(email)) continue;
		const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 120) || null : null;
		out.set(email, { email, name });
	}
	if (out.size > MAX_GUESTS) throw new CalendarError('guests');
	return [...out.values()];
}

export async function listAttendees(db: D1Database, eventId: string): Promise<AttendeeView[]> {
	const { results } = await db
		.prepare(`SELECT email, name, partstat FROM calendar_attendees WHERE event_id = ? ORDER BY email`)
		.bind(eventId)
		.all<AttendeeView>();
	return results;
}

/** Sets an event's guests. Existing guests keep their answers. */
export async function replaceAttendees(
	db: D1Database,
	eventId: string,
	guests: Guest[]
): Promise<{ added: Guest[]; removed: Guest[] }> {
	const current = await listAttendees(db, eventId);
	const wanted = new Map(guests.map((guest) => [guest.email, guest]));
	const removed = current.filter((attendee) => !wanted.has(attendee.email));
	const added = guests.filter((guest) => !current.some((attendee) => attendee.email === guest.email));
	const statements = [
		...removed.map((attendee) =>
			db.prepare(`DELETE FROM calendar_attendees WHERE event_id = ? AND email = ?`).bind(eventId, attendee.email)
		),
		...guests.map((guest) =>
			db
				.prepare(
					`INSERT INTO calendar_attendees (event_id, email, name) VALUES (?, ?, ?)
					 ON CONFLICT(event_id, email) DO UPDATE SET name = COALESCE(excluded.name, name)`
				)
				.bind(eventId, guest.email, guest.name)
		)
	];
	if (statements.length) await db.batch(statements);
	return { added, removed: removed.map((attendee) => ({ email: attendee.email, name: attendee.name })) };
}

function toIcs(row: EventRow, status: IcsEvent['status'] = row.status, sequence = row.sequence): IcsEvent {
	let exdates: string[] = [];
	try {
		exdates = JSON.parse(row.exdates_json) as string[];
	} catch {
		// none
	}
	return {
		uid: row.uid,
		sequence,
		title: row.title,
		description: row.description,
		location: row.location,
		allDay: row.all_day === 1,
		startLocal: row.start_local,
		endLocal: row.end_local,
		timezone: row.timezone,
		rrule: row.rrule,
		exdates,
		recurrenceLocal: row.recurrence_local,
		transparency: row.transparency,
		status,
		updatedAt: row.updated_at
	};
}

/** "Tuesday, November 10, 2026, 9:00 AM – 9:30 AM (America/Chicago)", in the event's own zone. */
export function describeWhen(event: {
	allDay: boolean;
	startLocal: string;
	endLocal: string;
	timezone: string;
	rrule: string | null;
}): string {
	let text: string;
	if (event.allDay) {
		const start = parseDate(event.startLocal.slice(0, 10));
		text = start
			? new Date(Date.UTC(start.year, start.month - 1, start.day)).toLocaleDateString('en-US', {
					timeZone: 'UTC',
					dateStyle: 'full'
				})
			: event.startLocal;
		text += ' (all day)';
	} else {
		const start = parseLocal(event.startLocal);
		const end = parseLocal(event.endLocal);
		if (!start || !end) return event.startLocal;
		const zone = event.timezone;
		const from = localToUtc(start, zone);
		const to = localToUtc(end, zone);
		const day = new Date(from).toLocaleDateString('en-US', { timeZone: zone, dateStyle: 'full' });
		const time = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' });
		text = `${day}, ${time(from)} – ${time(to)} (${zone.replace(/_/g, ' ')})`;
	}
	if (event.rrule) {
		try {
			text += `. ${describeRule(parseRule(event.rrule, event.timezone))}`;
		} catch {
			// shown without the repeat
		}
	}
	return text;
}

function base64(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

function inviteText(series: EventRow, intro: string, organizer: string): string {
	return [
		intro,
		'',
		series.title,
		`When: ${describeWhen({
			allDay: series.all_day === 1,
			startLocal: series.start_local,
			endLocal: series.end_local,
			timezone: series.timezone,
			rrule: series.rrule
		})}`,
		...(series.location ? [`Where: ${series.location}`] : []),
		...(series.description ? ['', series.description] : []),
		'',
		`Organized by ${organizer}. Reply with your calendar's Yes, Maybe or No.`
	].join('\n');
}

async function organizerAddress(db: D1Database, user: User, series: EventRow): Promise<MailAddress> {
	try {
		return await resolveFromAddress(db, user, null, series.send_from);
	} catch {
		throw new CalendarError('from');
	}
}

export type SendResult = { sent: number; error: string | null };

/**
 * Sends the current invite (series plus edited occurrences) to every guest,
 * and a cancellation to guests who were removed. With `cancelAll`, everyone
 * gets a cancellation instead (the event is being deleted).
 */
export async function sendInvites(
	db: D1Database,
	provider: EmailProvider,
	user: User,
	series: EventRow,
	options: { removed?: Guest[]; cancelAll?: boolean; attendees?: AttendeeView[]; edits?: EventRow[] } = {}
): Promise<SendResult> {
	if (series.organizer_email) return { sent: 0, error: null };
	const attendees = options.attendees ?? (await listAttendees(db, series.id));
	const removed = options.removed ?? [];
	if (attendees.length === 0 && removed.length === 0) return { sent: 0, error: null };
	const from = await organizerAddress(db, user, series);
	const organizer = { email: from.address, name: user.name || null };
	const edits = options.edits ?? (await editedOccurrences(db, series.id));
	let sent = 0;
	const errors: string[] = [];

	const send = async (method: 'REQUEST' | 'CANCEL', to: Guest[], people: InviteAttendee[]) => {
		if (to.length === 0) return;
		const cancelling = method === 'CANCEL';
		const events = [
			toIcs(series, cancelling ? 'cancelled' : series.status, cancelling ? series.sequence + 1 : series.sequence),
			...(cancelling ? [] : edits.map((edit) => toIcs(edit)))
		];
		const ics = calendarFile({
			name: series.title,
			timezone: series.timezone,
			events,
			method,
			extra: () => peopleLines(organizer, people)
		});
		const label = cancelling ? 'Canceled' : series.sequence > 0 ? 'Updated invitation' : 'Invitation';
		try {
			await sendOutboundEmail(provider, {
				from,
				senderName: user.name,
				to: to.map((guest) => guest.email),
				subject: `${label}: ${series.title}`.slice(0, 250),
				text: inviteText(
					series,
					cancelling ? 'This event has been canceled.' : `${user.name || from.address} invited you to:`,
					user.name || from.address
				),
				attachments: [{ filename: 'invite.ics', type: `text/calendar; method=${method}; charset=UTF-8`, content: base64(ics) }]
			});
			sent += to.length;
		} catch (error) {
			errors.push(error instanceof Error ? error.message : 'send failed');
		}
	};

	const people = attendees.map((attendee) => ({ email: attendee.email, name: attendee.name, partstat: attendee.partstat }));
	if (options.cancelAll) {
		await send('CANCEL', [...attendees, ...removed], people);
	} else {
		await send('REQUEST', attendees, people);
		await send('CANCEL', removed, removed.map((guest) => ({ ...guest, partstat: 'NEEDS-ACTION' })));
	}
	return { sent, error: errors[0] ?? null };
}

// ---------------------------------------------------------------------------
// Mail that arrives with a calendar file

/** Attachment types and names that carry iCalendar. */
export function isCalendarAttachment(type: string | null | undefined, filename: string | null | undefined): boolean {
	const kind = (type ?? '').toLowerCase();
	return kind.startsWith('text/calendar') || kind.startsWith('application/ics') || /\.ics$/i.test(filename ?? '');
}

type StoredInvite = {
	series: ParsedEvent | null;
	edits: ParsedEvent[];
	organizer: { email: string; name: string | null } | null;
	attendees: ParsedAttendee[];
};

/**
 * Records the calendar parts of a message that just arrived: invites and
 * updates (shown as a card, applied to events you already accepted),
 * cancellations, and RSVPs to your own events.
 */
export async function recordCalendarMail(
	db: D1Database,
	userId: string,
	emailId: string,
	files: string[],
	now = new Date()
): Promise<void> {
	const email = await db
		.prepare(`SELECT from_addr, security_json FROM emails WHERE id = ? AND user_id = ?`)
		.bind(emailId, userId)
		.first<{ from_addr: string; security_json: string | null }>();
	if (!email || files.length === 0) return;
	const from = email.from_addr.trim().toLowerCase();
	const security = parseSecurity(email.security_json);
	// Mail that may not be from who it says can show a card, but never changes your calendar.
	// Unchecked mail (no stored result) isn't trusted either.
	const trusted = !!security && security.verdict !== 'phishing' && security.auth.dmarc !== 'fail';
	const calendars = await ensureCalendars(db, userId, { name: 'Calendar', timezone: 'UTC' });
	const zone = (calendars.find((calendar) => calendar.isDefault) ?? calendars[0])?.timezone ?? 'UTC';
	const human = await humanPrincipalForUser(db, userId);

	let needsAnswer = false;
	for (const file of files.slice(0, 5)) {
		const parsed = parseCalendar(file, zone);
		const method = parsed.method ?? 'PUBLISH';
		if ((method === 'REQUEST' || method === 'COUNTER') && parsed.events.length) needsAnswer = true;
		for (const [uid, group] of groupByUid(parsed.events)) {
			const main = group.series ?? group.edits[0];
			if (!main) continue;
			const stored: StoredInvite = {
				series: group.series,
				edits: group.edits,
				organizer: main.organizer,
				attendees: main.attendees
			};
			await db
				.prepare(
					`INSERT INTO calendar_invites (id, user_id, email_id, uid, method, sequence, organizer_email, event_json, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(email_id, uid) DO UPDATE SET method = excluded.method, sequence = excluded.sequence,
					   organizer_email = excluded.organizer_email, event_json = excluded.event_json`
				)
				.bind(
					crypto.randomUUID(),
					userId,
					emailId,
					uid,
					method,
					main.sequence,
					main.organizer?.email ?? null,
					JSON.stringify(stored),
					now.toISOString()
				)
				.run();

			if (method === 'REPLY' || method === 'COUNTER') {
				// A guest answering your invite (or proposing a new time, which also carries
				// their answer): only their own answer counts, and only from mail that isn't
				// failing its sender checks. A proposal waits for you on its card.
				const answer = main.attendees.find((attendee) => attendee.email === from);
				if (!answer || !trusted) continue;
				for (const event of await eventsByUid(db, userId, uid)) {
					if (event.organizer_email) continue;
					await db
						.prepare(
							`UPDATE calendar_attendees SET partstat = ?, responded_at = ? WHERE event_id = ? AND email = ?`
						)
						.bind(cleanPartstat(answer.partstat), now.toISOString(), event.id, from)
						.run();
				}
				continue;
			}

			// Updates and cancellations apply to an invite you already accepted, from its organizer.
			if (!trusted || !main.organizer || main.organizer.email !== from) continue;
			for (const event of await eventsByUid(db, userId, uid)) {
				if (event.organizer_email !== from) continue;
				if (method === 'CANCEL') {
					if (group.series) {
						await db.prepare(`DELETE FROM calendar_events WHERE id = ?`).bind(event.id).run();
					} else {
						// Just some occurrences were canceled.
						let skip: string[] = [];
						try {
							skip = JSON.parse(event.exdates_json) as string[];
						} catch {
							// none
						}
						const keys = group.edits.map((edit) => edit.recurrenceLocal).filter((key): key is string => !!key);
						await db.batch([
							db
								.prepare(`UPDATE calendar_events SET exdates_json = ?, updated_at = ? WHERE id = ?`)
								.bind(JSON.stringify([...new Set([...skip, ...keys])]), now.toISOString(), event.id),
							...keys.map((key) =>
								db.prepare(`DELETE FROM calendar_events WHERE parent_id = ? AND recurrence_local = ?`).bind(event.id, key)
							)
						]);
					}
				} else if (method === 'REQUEST' && group.series && main.sequence >= event.sequence) {
					await upsertImportedEvent(
						db,
						{ id: event.calendar_id },
						{
							series: group.series,
							edits: group.edits,
							organizer: main.organizer,
							myStatus: event.my_status,
							sourceEmailId: emailId,
							createdBy: human.id
						},
						now
					);
				}
			}
		}
	}

	// An invite or a proposed new time waits on you: keep it out of Updates, so it's seen.
	if (needsAnswer && trusted) {
		await setThreadColumns(db, userId, [emailId], { category: 'primary' });
	}
}

export type InviteResponse = 'ACCEPTED' | 'TENTATIVE' | 'DECLINED';

/**
 * Answers an invite: puts it on your calendar (or takes it off) and sends
 * your RSVP to the organizer from the address it was sent to.
 */
export async function respondToInvite(
	db: D1Database,
	provider: EmailProvider | null,
	user: User,
	ownAddresses: string[],
	inviteId: string,
	response: InviteResponse,
	now = new Date()
): Promise<{ eventId: string | null; replied: boolean }> {
	const invite = await db
		.prepare(
			`SELECT i.*, e.from_addr, e.security_json FROM calendar_invites i JOIN emails e ON e.id = i.email_id
			 WHERE i.id = ? AND i.user_id = ?`
		)
		.bind(inviteId, user.id)
		.first<{
			id: string;
			email_id: string;
			uid: string;
			method: string;
			event_json: string;
			from_addr: string;
			security_json: string | null;
		}>();
	if (!invite) throw new CalendarError('missing');
	if (invite.method === 'COUNTER') {
		return respondToCounter(db, provider, user, invite, response === 'ACCEPTED' ? 'accept' : 'decline', now);
	}
	if (invite.method !== 'REQUEST' && invite.method !== 'PUBLISH') throw new CalendarError('occurrence');
	const stored = JSON.parse(invite.event_json) as StoredInvite;
	if (!stored.series) throw new CalendarError('occurrence');
	const human = await humanPrincipalForUser(db, user.id);

	let eventId: string | null = null;
	if (response === 'DECLINED') {
		for (const event of await eventsByUid(db, user.id, invite.uid)) {
			if (event.organizer_email) await db.prepare(`DELETE FROM calendar_events WHERE id = ?`).bind(event.id).run();
		}
	} else {
		// The organizer named in a file can be made up. Replacing an event already on your
		// calendar takes mail that really comes from that organizer.
		const existing = await eventsByUid(db, user.id, invite.uid);
		if (existing.length) {
			const security = parseSecurity(invite.security_json);
			const verified =
				!!security &&
				security.verdict !== 'phishing' &&
				security.auth.dmarc !== 'fail' &&
				!!stored.organizer &&
				invite.from_addr.trim().toLowerCase() === stored.organizer.email;
			if (!verified) throw new CalendarError('conflict');
		}
		const calendars = await ensureCalendars(db, user.id, { name: user.name || 'Calendar', timezone: stored.series.timezone });
		const calendar = calendars.find((item) => item.isDefault) ?? calendars[0];
		eventId = await upsertImportedEvent(
			db,
			calendar,
			{
				series: stored.series,
				edits: stored.edits,
				// Without an organizer it's an "add to calendar" file; it's still not yours to send invites for.
				organizer: stored.organizer ?? { email: 'unknown@invalid', name: null },
				myStatus: response.toLowerCase(),
				sourceEmailId: invite.email_id,
				createdBy: human.id
			},
			now
		);
		if (!eventId) throw new CalendarError('time');
	}

	await db
		.prepare(`UPDATE calendar_invites SET response = ?, responded_at = ? WHERE id = ?`)
		.bind(response, now.toISOString(), invite.id)
		.run();

	// RSVP to the organizer, from whichever of your addresses they invited.
	let replied = false;
	const organizer = stored.organizer;
	const own = ownAddresses.map((address) => address.toLowerCase());
	if (provider && invite.method === 'REQUEST' && organizer && !own.includes(organizer.email)) {
		const me = stored.attendees.find((attendee) => own.includes(attendee.email))?.email ?? null;
		let from: MailAddress | null = null;
		try {
			from = await resolveFromAddress(db, user, null, me);
		} catch {
			from = null;
		}
		if (from) {
			const label = response === 'ACCEPTED' ? 'Accepted' : response === 'TENTATIVE' ? 'Tentatively accepted' : 'Declined';
			const ics = replyFile({
				uid: invite.uid,
				sequence: stored.series.sequence,
				title: stored.series.title,
				organizer,
				attendee: { email: from.address, name: user.name || null },
				partstat: response,
				start: { allDay: stored.series.allDay, local: stored.series.startLocal, timezone: stored.series.timezone },
				now
			});
			try {
				await sendOutboundEmail(provider, {
					from,
					senderName: user.name,
					to: [organizer.email],
					subject: `${label}: ${stored.series.title}`.slice(0, 250),
					text: `${user.name || from.address} ${label.toLowerCase()} this invitation.`,
					attachments: [{ filename: 'reply.ics', type: 'text/calendar; method=REPLY; charset=UTF-8', content: base64(ics) }]
				});
				replied = true;
			} catch (error) {
				console.error('Could not send the RSVP', invite.id, error);
			}
		}
	}
	return { eventId, replied };
}

/**
 * A guest proposed a new time for your event (COUNTER). Accepting moves the
 * event (or just that occurrence) and sends every guest the update; declining
 * tells the guest the time stays. Only a guest of the event, in mail that
 * passes its sender checks, can propose.
 */
async function respondToCounter(
	db: D1Database,
	provider: EmailProvider | null,
	user: User,
	invite: { id: string; uid: string; event_json: string; from_addr: string; security_json: string | null },
	decision: 'accept' | 'decline',
	now: Date
): Promise<{ eventId: string | null; replied: boolean }> {
	const stored = JSON.parse(invite.event_json) as StoredInvite;
	const proposed = stored.series ?? stored.edits[0];
	const from = invite.from_addr.trim().toLowerCase();
	const security = parseSecurity(invite.security_json);
	if (!proposed || !security || security.verdict === 'phishing' || security.auth.dmarc === 'fail') {
		throw new CalendarError('conflict');
	}
	const event = (await eventsByUid(db, user.id, invite.uid)).find((row) => !row.organizer_email);
	if (!event) throw new CalendarError('missing');
	const guest = (await listAttendees(db, event.id)).find((attendee) => attendee.email === from);
	if (!guest) throw new CalendarError('conflict');

	let replied = false;
	if (decision === 'accept') {
		const timing = { start: proposed.startLocal, end: proposed.endLocal, timezone: proposed.timezone, allDay: proposed.allDay };
		// A proposal for one occurrence of a repeating event moves just that one.
		await updateEvent(
			db,
			user.id,
			event.id,
			proposed.recurrenceLocal && event.rrule ? { ...timing, occurrence: proposed.recurrenceLocal } : timing,
			now
		);
		if (provider) {
			const result = await sendInvites(db, provider, user, await seriesOf(db, user.id, event.id));
			replied = result.sent > 0 && !result.error;
		}
	} else if (provider) {
		try {
			const sender = await resolveFromAddress(db, user, null, event.send_from);
			const ics = declineCounterFile({
				uid: event.uid,
				sequence: event.sequence,
				title: event.title,
				organizer: { email: sender.address, name: user.name || null },
				attendee: { email: guest.email, name: guest.name },
				start: { allDay: event.all_day === 1, local: event.start_local, timezone: event.timezone },
				now
			});
			await sendOutboundEmail(provider, {
				from: sender,
				senderName: user.name,
				to: [guest.email],
				subject: `New time declined: ${event.title}`.slice(0, 250),
				text: `${user.name || sender.address} is keeping the current time for "${event.title}".`,
				attachments: [{ filename: 'invite.ics', type: 'text/calendar; method=DECLINECOUNTER; charset=UTF-8', content: base64(ics) }]
			});
			replied = true;
		} catch (error) {
			console.error('Could not send the declined proposal', invite.id, error);
		}
	}
	await db
		.prepare(`UPDATE calendar_invites SET response = ?, responded_at = ? WHERE id = ?`)
		.bind(decision === 'accept' ? 'ACCEPTED' : 'DECLINED', now.toISOString(), invite.id)
		.run();
	return { eventId: event.id, replied };
}

// ---------------------------------------------------------------------------
// What the reader shows

/** Invite cards for the messages in a thread, by email id. */
export async function invitesForEmails(db: D1Database, userId: string, emailIds: string[]): Promise<Record<string, InviteView>> {
	const out: Record<string, InviteView> = {};
	if (emailIds.length === 0) return out;
	const { results } = await db
		.prepare(
			`SELECT i.*, e.from_addr,
			        EXISTS (SELECT 1 FROM calendar_events ev JOIN calendars c ON c.id = ev.calendar_id
			                JOIN principals p ON p.id = c.owner_principal_id
			                WHERE p.user_id = i.user_id AND ev.uid = i.uid AND ev.parent_id IS NULL) AS on_calendar
			 FROM calendar_invites i JOIN emails e ON e.id = i.email_id
			 WHERE i.user_id = ? AND i.email_id IN (SELECT value FROM json_each(?))`
		)
		.bind(userId, JSON.stringify(emailIds))
		.all<{
			id: string;
			email_id: string;
			uid: string;
			method: string;
			event_json: string;
			response: string | null;
			from_addr: string;
			on_calendar: number;
		}>();
	for (const row of results) {
		let stored: StoredInvite;
		try {
			stored = JSON.parse(row.event_json) as StoredInvite;
		} catch {
			continue;
		}
		const main = stored.series ?? stored.edits[0];
		if (!main || out[row.email_id]) continue;
		const from = row.from_addr.trim().toLowerCase();
		const answer =
			row.method === 'REPLY' || row.method === 'COUNTER'
				? stored.attendees.find((attendee) => attendee.email === from)
				: undefined;
		let proposal: InviteView['proposal'] = null;
		if (row.method === 'COUNTER') {
			const mine = (await eventsByUid(db, userId, row.uid)).find((event) => !event.organizer_email);
			proposal = {
				current: mine
					? describeWhen({
							allDay: mine.all_day === 1,
							startLocal: mine.start_local,
							endLocal: mine.end_local,
							timezone: mine.timezone,
							rrule: mine.rrule
						})
					: null
			};
		}
		out[row.email_id] = {
			id: row.id,
			method: row.method,
			title: main.title,
			when: describeWhen(main),
			location: main.location,
			organizer: stored.organizer,
			response: row.response,
			onCalendar: row.on_calendar === 1,
			reply: answer ? { email: answer.email, name: answer.name, partstat: answer.partstat } : null,
			proposal
		};
	}
	return out;
}
