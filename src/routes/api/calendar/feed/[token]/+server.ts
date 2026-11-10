import type { RequestHandler } from '@sveltejs/kit';
import { calendarFile, type IcsEvent } from '#lib/calendar/ics.ts';
import { calendarForFeedToken, eventsForFeed } from '#lib/server/calendar-store.ts';

/**
 * The secret subscribe link (…/feed/<token>.ics). No sign-in: the token is
 * the key, it's stored only as a hash, and it can be turned off or replaced.
 * Phones and other calendar apps poll it.
 */
export const GET: RequestHandler = async ({ params, platform }) => {
	const db = platform?.env.DB;
	const token = (params.token ?? '').replace(/\.ics$/, '');
	const calendar = db ? await calendarForFeedToken(db, token) : null;
	if (!db || !calendar) return new Response('Not found', { status: 404 });

	const rows = await eventsForFeed(db, calendar.id);
	const events: IcsEvent[] = rows.map((row) => {
		let exdates: string[] = [];
		try {
			exdates = JSON.parse(row.exdates_json) as string[];
		} catch {
			// none
		}
		return {
			uid: row.uid,
			sequence: row.sequence,
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
			status: row.status,
			updatedAt: row.updated_at
		};
	});
	return new Response(calendarFile({ name: calendar.name, timezone: calendar.timezone, events }), {
		headers: {
			'Content-Type': 'text/calendar; charset=utf-8',
			'Cache-Control': 'private, max-age=300',
			'X-Robots-Tag': 'noindex'
		}
	});
};
