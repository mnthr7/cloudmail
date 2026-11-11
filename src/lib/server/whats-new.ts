import type { D1Database } from '@cloudflare/workers-types';
import { CATEGORIES, type MailCategory } from '#lib/organizing/categories.ts';
import { localToUtc, parseDate, parseLocal } from '#lib/calendar/time.ts';
import type { ParsedEvent } from '#lib/calendar/ics-parse.ts';
import { viewFilter } from './mail-store.ts';

/**
 * "What's new" markers: how many conversations arrived in each inbox tab since
 * you last opened it, and what on the calendar is waiting on you or changed
 * since you last looked. Seen times live in `seen_marks`.
 */

export type TabNews = Partial<Record<MailCategory, { count: number; senders: string[] }>>;

export type CalendarItem = {
	inviteId: string;
	emailId: string;
	method: string;
	title: string;
	from: string;
	at: string;
};

export type CalendarNews = {
	/** Invites to answer and proposed new times to accept or turn down. */
	waiting: CalendarItem[];
	/** Updates, cancellations and replies since you last opened the calendar. */
	updates: number;
};

export async function markSeen(db: D1Database, userId: string, scope: string, now = new Date()): Promise<void> {
	await db
		.prepare(
			`INSERT INTO seen_marks (user_id, scope, seen_at) VALUES (?, ?, ?)
			 ON CONFLICT(user_id, scope) DO UPDATE SET seen_at = excluded.seen_at`
		)
		.bind(userId, scope, now.toISOString())
		.run();
}

const SENDERS_PER_TAB = 3;

/**
 * Unread conversations that arrived in each tab since you last opened it.
 * Primary isn't counted (the Inbox badge covers it), nor is the tab you're on.
 * A tab you've never opened counts all its unread conversations.
 */
export async function newInTabs(
	db: D1Database,
	userId: string,
	domainId: string | null,
	activeTab: MailCategory | null
): Promise<TabNews> {
	const tabs = CATEGORIES.filter((tab) => tab !== 'primary' && tab !== activeTab);
	if (tabs.length === 0) return {};
	const bindings: unknown[] = [userId, JSON.stringify(tabs)];
	let scope = '';
	if (domainId) {
		scope = 'AND e.domain_id = ?';
		bindings.push(domainId);
	}
	const { results } = await db
		.prepare(
			`SELECT e.category, COALESCE(e.thread_id, e.id) AS thread_id, e.from_name, e.from_addr
			 FROM emails e
			 LEFT JOIN seen_marks s ON s.user_id = e.user_id AND s.scope = 'tab:' || e.category
			 WHERE e.user_id = ? AND e.category IN (SELECT value FROM json_each(?)) ${scope}
			   AND ${viewFilter('inbox')} AND e.is_read = 0
			   AND (s.seen_at IS NULL OR datetime(e.created_at) > datetime(s.seen_at))
			 ORDER BY datetime(e.created_at) DESC
			 LIMIT 2000`
		)
		.bind(...bindings)
		.all<{ category: MailCategory; thread_id: string; from_name: string | null; from_addr: string }>();

	const out: TabNews = {};
	const threads = new Map<MailCategory, Set<string>>();
	for (const row of results) {
		const seen = threads.get(row.category) ?? new Set<string>();
		threads.set(row.category, seen);
		if (seen.has(row.thread_id)) continue;
		seen.add(row.thread_id);
		const tab = (out[row.category] ??= { count: 0, senders: [] });
		tab.count++;
		const name = (row.from_name?.trim() || row.from_addr).slice(0, 60);
		if (tab.senders.length < SENDERS_PER_TAB && !tab.senders.includes(name)) tab.senders.push(name);
	}
	return out;
}

/** Counts the tabs, then marks the open one seen. Never breaks the inbox. */
export async function tabNewsForInbox(
	db: D1Database,
	userId: string,
	domainId: string | null,
	activeTab: MailCategory | null,
	now = new Date()
): Promise<TabNews> {
	try {
		const news = await newInTabs(db, userId, domainId, activeTab);
		if (activeTab) await markSeen(db, userId, `tab:${activeTab}`, now);
		return news;
	} catch (error) {
		console.error('Could not count new mail in the inbox tabs', error);
		return {};
	}
}

type InviteRow = {
	id: string;
	email_id: string;
	uid: string;
	method: string;
	event_json: string;
	response: string | null;
	created_at: string;
	from_addr: string;
	from_name: string | null;
	on_calendar: number;
	mine: number;
	answered_later: number;
};

/** When the event (or a one-off's last day) ends, in ms. Repeating events count as upcoming. */
function endsAt(event: ParsedEvent): number | null {
	if (event.rrule) return null;
	const local = parseLocal(event.endLocal);
	if (local) return localToUtc(local, event.timezone);
	const date = parseDate(event.endLocal);
	return date ? localToUtc({ ...date, hour: 0, minute: 0 }, event.timezone) : null;
}

const UPDATE_WINDOW_MS = 7 * 24 * 3_600_000;

/**
 * What the calendar should flag: invites you haven't answered and proposed new
 * times you haven't decided on (for events still ahead), plus updates,
 * cancellations and replies since you last opened the calendar (or the last
 * week, if you never have).
 */
export async function calendarNews(db: D1Database, userId: string, now = new Date()): Promise<CalendarNews> {
	const seen = await db
		.prepare(`SELECT seen_at FROM seen_marks WHERE user_id = ? AND scope = 'calendar'`)
		.bind(userId)
		.first<{ seen_at: string }>();
	const since = seen?.seen_at ?? new Date(now.getTime() - UPDATE_WINDOW_MS).toISOString();

	const { results } = await db
		.prepare(
			`SELECT i.id, i.email_id, i.uid, i.method, i.event_json, i.response, i.created_at,
			        e.from_addr, e.from_name,
			        EXISTS (SELECT 1 FROM calendar_events ev JOIN calendars c ON c.id = ev.calendar_id
			                JOIN principals p ON p.id = c.owner_principal_id
			                WHERE p.user_id = i.user_id AND ev.uid = i.uid AND ev.parent_id IS NULL) AS on_calendar,
			        EXISTS (SELECT 1 FROM calendar_events ev JOIN calendars c ON c.id = ev.calendar_id
			                JOIN principals p ON p.id = c.owner_principal_id
			                WHERE p.user_id = i.user_id AND ev.uid = i.uid AND ev.parent_id IS NULL
			                  AND ev.organizer_email IS NULL) AS mine,
			        EXISTS (SELECT 1 FROM calendar_invites o JOIN emails oe ON oe.id = o.email_id
			                WHERE o.user_id = i.user_id AND o.uid = i.uid AND o.method = i.method
			                  AND o.response IS NOT NULL AND o.id <> i.id
			                  AND datetime(o.created_at) >= datetime(i.created_at)
			                  -- A proposed time is answered per guest.
			                  AND (i.method <> 'COUNTER' OR lower(trim(oe.from_addr)) = lower(trim(e.from_addr)))) AS answered_later
			 FROM calendar_invites i
			 JOIN emails e ON e.id = i.email_id AND e.deleted_at IS NULL AND e.is_spam = 0
			 WHERE i.user_id = ?
			   AND ((i.method IN ('REQUEST', 'COUNTER') AND i.response IS NULL)
			        OR datetime(i.created_at) > datetime(?))
			 ORDER BY datetime(i.created_at) DESC
			 LIMIT 200`
		)
		.bind(userId, since)
		.all<InviteRow>();

	const waiting: CalendarItem[] = [];
	const waitingKeys = new Set<string>();
	const updated = new Set<string>();
	// Rows run newest first, so a cancellation is seen before the invite it cancels.
	const cancelled = new Set<string>();
	const sinceMs = Date.parse(since);
	for (const row of results) {
		let main: ParsedEvent | null = null;
		let wholeSeries = false;
		try {
			const stored = JSON.parse(row.event_json) as { series: ParsedEvent | null; edits: ParsedEvent[] };
			main = stored.series ?? stored.edits[0] ?? null;
			wholeSeries = !!stored.series;
		} catch {
			// unreadable: skip
		}
		if (!main) continue;
		if (row.method === 'CANCEL' && wholeSeries) cancelled.add(row.uid);
		const from = row.from_addr.trim().toLowerCase();
		const end = endsAt(main);
		const ahead = end === null || end > now.getTime();
		const open = row.response === null && !row.answered_later && ahead && !cancelled.has(row.uid);
		const needsAnswer =
			open &&
			((row.method === 'REQUEST' && !row.on_calendar) || (row.method === 'COUNTER' && !!row.mine));
		if (needsAnswer) {
			// The newest of the same invite (or the same guest's proposal) stands for the rest.
			const key = `${row.method}|${row.uid}|${row.method === 'COUNTER' ? from : ''}`;
			if (waitingKeys.has(key)) continue;
			waitingKeys.add(key);
			waiting.push({
				inviteId: row.id,
				emailId: row.email_id,
				method: row.method,
				title: main.title || '(no title)',
				from: row.from_name?.trim() || from,
				at: row.created_at
			});
			continue;
		}
		if (Date.parse(row.created_at) > sinceMs && !waitingKeys.has(`REQUEST|${row.uid}|`)) updated.add(row.uid);
	}
	return { waiting, updates: updated.size };
}

/** The calendar badge: what's waiting plus what changed. Opening the calendar clears the changes. */
export async function calendarBadge(
	db: D1Database,
	userId: string,
	onCalendarPage: boolean,
	now = new Date()
): Promise<CalendarNews> {
	try {
		if (onCalendarPage) await markSeen(db, userId, 'calendar', now);
		return await calendarNews(db, userId, now);
	} catch (error) {
		console.error('Could not count calendar news', error);
		return { waiting: [], updates: 0 };
	}
}
