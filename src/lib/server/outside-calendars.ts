import type { D1Database } from '@cloudflare/workers-types';
import { FEED_LIMITS, groupByUid, parseCalendar, type ParsedEvent } from '#lib/calendar/ics-parse.ts';
import { parseRule } from '#lib/calendar/recurrence.ts';
import { localToUtc, parseDate, parseLocal } from '#lib/calendar/time.ts';
import { CALENDAR_COLORS, type CalendarInfo } from '#lib/calendar/types.ts';
import { humanPrincipalForUser } from './agents-store.ts';
import { CalendarError, listCalendars, replaceCalendarEvents } from './calendar-store.ts';
import { openSecret, sealSecret } from './secret-box.ts';

/**
 * Calendar step 3: outside calendars. You paste the secret iCal link from
 * Google Calendar, iCloud or Outlook; CloudMail keeps a read-only copy,
 * refreshed every 15 minutes, so your free time (and booking pages) account
 * for everything. The link works like a password, so it's stored sealed.
 */

export const REFRESH_MS = 15 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
/** Kept: from a month back to a little over a year ahead. */
const KEEP_BACK_MS = 31 * 86_400_000;
const KEEP_AHEAD_MS = 400 * 86_400_000;
const MAX_SERIES = 2_000;
/** Refresh now at most this often per calendar, so a feed can't be made to rewrite itself on demand. */
const MANUAL_REFRESH_MS = 2 * 60_000;
const MAX_OUTSIDE_CALENDARS = 10;

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

const sealContext = (calendarId: string) => `calendar-feed:${calendarId}`;

/**
 * The link as it will be fetched: https only (webcal:// is the same thing),
 * a real host name, no user name or password in it.
 */
export function readFeedUrl(input: unknown): URL {
	if (typeof input !== 'string') throw new CalendarError('source');
	const text = input.trim().replace(/^webcals?:\/\//i, 'https://');
	if (!text || text.length > 2000) throw new CalendarError('source');
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		throw new CalendarError('source');
	}
	// "localhost." and "localhost" are the same host.
	const host = url.hostname.toLowerCase().replace(/\.+$/, '');
	if (
		url.protocol !== 'https:' ||
		url.username ||
		url.password ||
		(url.port && url.port !== '443') ||
		!host.includes('.') ||
		/^[\d.]+$/.test(host) ||
		host.startsWith('[') ||
		/(^|\.)(localhost|local|internal|lan|home|test|invalid|example)$/.test(host)
	) {
		throw new CalendarError('source');
	}
	return url;
}

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Reads the body, stopping at the size limit. */
async function readCapped(response: Response, maxBytes: number): Promise<string | null> {
	const reader = response.body?.getReader();
	if (!reader) return '';
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		chunks.push(value);
	}
	const all = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		all.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(all);
}

class FeedError extends Error {}

const MAX_REDIRECTS = 3;

async function download(fetcher: Fetcher, first: URL): Promise<string> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		let response: Response | null = null;
		let url = first;
		// Redirects are followed by hand, and every hop must pass the same checks as the link itself.
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			try {
				response = await fetcher(url.toString(), {
					headers: { Accept: 'text/calendar, */*;q=0.5', 'User-Agent': 'CloudMail calendar' },
					redirect: 'manual',
					signal: controller.signal
				});
			} catch {
				throw new FeedError("Couldn't reach that calendar link.");
			}
			if (response.status < 300 || response.status >= 400) break;
			const location = response.headers.get('location');
			await response.body?.cancel().catch(() => undefined);
			if (!location || hop === MAX_REDIRECTS) throw new FeedError('That link keeps redirecting. Paste the final calendar link.');
			try {
				url = readFeedUrl(new URL(location, url).toString());
			} catch {
				throw new FeedError('That link redirects somewhere CloudMail won’t fetch from.');
			}
			response = null;
		}
		if (!response) throw new FeedError("Couldn't reach that calendar link.");
		if (response.status === 401 || response.status === 403 || response.status === 404) {
			throw new FeedError('That link no longer works. It may have been reset; paste the new one.');
		}
		if (!response.ok) throw new FeedError('The calendar service answered with an error. It will try again soon.');
		const text = await readCapped(response, FEED_LIMITS.maxBytes);
		if (text === null) throw new FeedError('That calendar is too big to copy (over 5 MB).');
		if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 4096))) {
			throw new FeedError("That link isn't a calendar. Use the secret address in iCal format.");
		}
		return text;
	} finally {
		clearTimeout(timer);
	}
}

/** When an event ends (UTC ms), or null if it can't be read. */
function endOf(event: ParsedEvent): number | null {
	const local = parseLocal(event.endLocal);
	if (local) return localToUtc(local, event.timezone);
	const date = parseDate(event.endLocal);
	return date ? localToUtc({ ...date, hour: 0, minute: 0 }, event.timezone) : null;
}

function startOf(event: ParsedEvent): number | null {
	const local = parseLocal(event.startLocal);
	if (local) return localToUtc(local, event.timezone);
	const date = parseDate(event.startLocal);
	return date ? localToUtc({ ...date, hour: 0, minute: 0 }, event.timezone) : null;
}

/**
 * The feed's events worth keeping: not canceled, not long over, not years out.
 * Busy-only copies skip events marked free, since they'd say nothing.
 */
export function eventsToKeep(
	text: string,
	zone: string,
	details: boolean,
	now: Date
): Array<{ series: ParsedEvent; edits: ParsedEvent[] }> {
	const parsed = parseCalendar(text, zone, FEED_LIMITS);
	const from = now.getTime() - KEEP_BACK_MS;
	const to = now.getTime() + KEEP_AHEAD_MS;
	const out: Array<{ series: ParsedEvent; edits: ParsedEvent[] }> = [];
	for (const group of groupByUid(parsed.events).values()) {
		const series = group.series;
		if (!series || series.status === 'cancelled') continue;
		if (!details && series.transparency === 'free') continue;
		const start = startOf(series);
		if (start === null || start > to) continue;
		if (series.rrule) {
			let until: number | undefined;
			try {
				until = parseRule(series.rrule, series.timezone).until;
			} catch {
				until = undefined;
			}
			if (until !== undefined && until < from) continue;
			// A canceled single occurrence is the same as skipping it.
			const canceled = group.edits.filter((edit) => edit.status === 'cancelled' && edit.recurrenceLocal);
			const edits = group.edits.filter((edit) => edit.status !== 'cancelled' && (details || edit.transparency !== 'free'));
			out.push({
				series: { ...series, exdates: [...series.exdates, ...canceled.map((edit) => edit.recurrenceLocal!)] },
				edits
			});
		} else {
			const end = endOf(series);
			if (end === null || end < from) continue;
			out.push({ series, edits: [] });
		}
		if (out.length >= MAX_SERIES) break;
	}
	return out;
}

type SourceRow = {
	id: string;
	timezone: string;
	source_url_sealed: string;
	source_details: number;
	source_hash: string | null;
};

/**
 * Refreshes one outside calendar. Unchanged feeds aren't rewritten. A failure
 * keeps the last good copy and records why, in words the person can act on.
 */
export async function syncOutsideCalendar(
	db: D1Database,
	key: CryptoKey,
	row: SourceRow,
	fetcher: Fetcher,
	now = new Date()
): Promise<{ ok: boolean; error: string | null; events: number | null }> {
	const at = now.toISOString();
	try {
		const url = readFeedUrl(await openSecret(key, row.source_url_sealed, sealContext(row.id)));
		const text = await download(fetcher, url);
		const hash = await sha256(`${row.source_details}:${text}`);
		if (hash === row.source_hash) {
			await db
				.prepare(`UPDATE calendars SET source_synced_at = ?, source_error = NULL WHERE id = ?`)
				.bind(at, row.id)
				.run();
			return { ok: true, error: null, events: null };
		}
		const groups = eventsToKeep(text, row.timezone, row.source_details === 1, now);
		const kept = await replaceCalendarEvents(db, row.id, groups, { details: row.source_details === 1 }, now);
		await db
			.prepare(`UPDATE calendars SET source_synced_at = ?, source_error = NULL, source_hash = ?, updated_at = ? WHERE id = ?`)
			.bind(at, hash, at, row.id)
			.run();
		return { ok: true, error: null, events: kept };
	} catch (error) {
		const message =
			error instanceof FeedError
				? error.message
				: error instanceof CalendarError
					? "That link can't be used. Paste the calendar's secret iCal address."
					: "Couldn't refresh this calendar. It will try again soon.";
		// Never the error itself: it could one day carry the secret link.
		if (!(error instanceof FeedError)) {
			console.error('Outside calendar refresh failed', row.id, error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : 'unknown');
		}
		await db
			.prepare(`UPDATE calendars SET source_synced_at = ?, source_error = ? WHERE id = ?`)
			.bind(at, message, row.id)
			.run();
		return { ok: false, error: message, events: null };
	}
}

/** Adds an outside calendar and copies it once right away. */
export async function addOutsideCalendar(
	db: D1Database,
	key: CryptoKey,
	userId: string,
	input: { url: unknown; name: unknown; color?: unknown; details?: unknown; timezone: string },
	fetcher: Fetcher,
	now = new Date()
): Promise<{ calendar: CalendarInfo; error: string | null }> {
	const url = readFeedUrl(input.url);
	const name =
		typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 80) : url.hostname.slice(0, 80);
	const color = input.color ?? 'gray';
	if (!(CALENDAR_COLORS as readonly unknown[]).includes(color)) throw new CalendarError('color');
	const human = await humanPrincipalForUser(db, userId);
	const id = crypto.randomUUID();
	const at = now.toISOString();
	const details = input.details === true ? 1 : 0;
	// The limit is checked in the same statement, so adding many at once can't pass it.
	const inserted = await db
		.prepare(
			`INSERT INTO calendars (id, workspace_id, owner_principal_id, name, color, timezone, is_default, created_at, updated_at,
			                        source_url_sealed, source_host, source_details)
			 SELECT ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?
			 WHERE (SELECT COUNT(*) FROM calendars WHERE owner_principal_id = ? AND source_url_sealed IS NOT NULL) < ?`
		)
		.bind(
			id,
			human.workspace_id,
			human.id,
			name,
			color,
			input.timezone,
			at,
			at,
			await sealSecret(key, url.toString(), sealContext(id)),
			url.hostname.slice(0, 200),
			details,
			human.id,
			MAX_OUTSIDE_CALENDARS
		)
		.run();
	if (!inserted.meta.changes) throw new CalendarError('limit');
	const sealed = await db.prepare(`SELECT * FROM calendars WHERE id = ?`).bind(id).first<SourceRow>();
	const result = await syncOutsideCalendar(db, key, sealed!, fetcher, now);
	const calendar = (await listCalendars(db, userId)).find((item) => item.id === id)!;
	return { calendar, error: result.error };
}

async function ownedSource(db: D1Database, userId: string, calendarId: string): Promise<SourceRow> {
	const human = await humanPrincipalForUser(db, userId);
	const row = await db
		.prepare(`SELECT * FROM calendars WHERE id = ? AND owner_principal_id = ? AND source_url_sealed IS NOT NULL`)
		.bind(calendarId, human.id)
		.first<SourceRow>();
	if (!row) throw new CalendarError('calendar');
	return row;
}

/** Refresh now (the person pressed Refresh). */
export async function refreshOutsideCalendar(
	db: D1Database,
	key: CryptoKey,
	userId: string,
	calendarId: string,
	fetcher: Fetcher,
	now = new Date()
): Promise<{ error: string | null; recent?: boolean }> {
	const row = await ownedSource(db, userId, calendarId);
	// Same claim as the scheduled refresh: one at a time, and not more than every couple of minutes.
	const since = new Date(now.getTime() - MANUAL_REFRESH_MS).toISOString();
	const claim = await db
		.prepare(`UPDATE calendars SET source_synced_at = ? WHERE id = ? AND (source_synced_at IS NULL OR source_synced_at < ?)`)
		.bind(now.toISOString(), row.id, since)
		.run();
	if (!claim.meta.changes) return { error: null, recent: true };
	const result = await syncOutsideCalendar(db, key, row, fetcher, now);
	return { error: result.error };
}

/** Switch between copying details and just "Busy"; the copy is rebuilt on the next refresh. */
export async function setOutsideDetails(db: D1Database, userId: string, calendarId: string, details: boolean): Promise<void> {
	const row = await ownedSource(db, userId, calendarId);
	await db
		.prepare(`UPDATE calendars SET source_details = ?, source_hash = NULL, source_synced_at = NULL WHERE id = ?`)
		.bind(details ? 1 : 0, row.id)
		.run();
}

/** Removes the copy (not the original, which CloudMail never touches). */
export async function removeOutsideCalendar(db: D1Database, userId: string, calendarId: string): Promise<void> {
	const row = await ownedSource(db, userId, calendarId);
	await db.prepare(`DELETE FROM calendars WHERE id = ?`).bind(row.id).run();
}

/** The cron's share: refresh a few calendars that are due, oldest first. */
export async function syncDueOutsideCalendars(
	db: D1Database,
	key: CryptoKey,
	fetcher: Fetcher,
	now = new Date(),
	limit = 3
): Promise<number> {
	const due = new Date(now.getTime() - REFRESH_MS).toISOString();
	const { results } = await db
		.prepare(
			`SELECT id, timezone, source_url_sealed, source_details, source_hash FROM calendars
			 WHERE source_url_sealed IS NOT NULL AND (source_synced_at IS NULL OR source_synced_at < ?)
			 ORDER BY source_synced_at IS NOT NULL, source_synced_at
			 LIMIT ?`
		)
		.bind(due, limit)
		.all<SourceRow>();
	let synced = 0;
	for (const row of results) {
		// Claim it first, so two runs at once don't both rewrite the same calendar.
		const claim = await db
			.prepare(
				`UPDATE calendars SET source_synced_at = ? WHERE id = ? AND (source_synced_at IS NULL OR source_synced_at < ?)`
			)
			.bind(now.toISOString(), row.id, due)
			.run();
		if (!claim.meta.changes) continue;
		await syncOutsideCalendar(db, key, row, fetcher, now);
		synced++;
	}
	return synced;
}
