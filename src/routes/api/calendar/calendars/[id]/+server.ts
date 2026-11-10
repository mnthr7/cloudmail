import { json, type RequestHandler } from '@sveltejs/kit';
import { calendarCaller, calendarFailure, readJson } from '#lib/server/calendar-http.ts';
import { updateCalendar } from '#lib/server/calendar-store.ts';

/** Rename a calendar, or change its color or default zone. */
export const PATCH: RequestHandler = async ({ params, request, locals, platform }) => {
	const who = calendarCaller(locals, platform, { write: true });
	if ('response' in who) return who.response;
	const body = await readJson(request);
	try {
		await updateCalendar(who.db, who.userId, params.id ?? '', body);
		return json({ ok: true });
	} catch (error) {
		return calendarFailure(error);
	}
};
