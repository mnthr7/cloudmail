import { json, type RequestHandler } from '@sveltejs/kit';
import { calendarCaller, calendarFailure, readJson } from '#lib/server/calendar-http.ts';
import { createEvent, listCalendars, occurrencesInRange } from '#lib/server/calendar-store.ts';

/** Occurrences between `start` and `end` (ISO instants) on the user's calendars. */
export const GET: RequestHandler = async ({ url, locals, platform }) => {
	const who = calendarCaller(locals, platform, { write: false });
	if ('response' in who) return who.response;
	const start = Date.parse(url.searchParams.get('start') ?? '');
	const end = Date.parse(url.searchParams.get('end') ?? '');
	if (!Number.isFinite(start) || !Number.isFinite(end)) return json({ error: 'range' }, { status: 400 });
	try {
		const calendars = await listCalendars(who.db, who.userId);
		return json({ occurrences: await occurrencesInRange(who.db, calendars, start, end) });
	} catch (error) {
		return calendarFailure(error);
	}
};

export const POST: RequestHandler = async ({ request, url, locals, platform }) => {
	const who = calendarCaller(locals, platform, { write: true });
	if ('response' in who) return who.response;
	const body = await readJson(request);
	try {
		const id = await createEvent(who.db, who.userId, body, { uidDomain: url.hostname });
		return json({ id }, { status: 201 });
	} catch (error) {
		return calendarFailure(error);
	}
};
