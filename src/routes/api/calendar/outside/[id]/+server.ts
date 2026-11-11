import { json, type RequestHandler } from '@sveltejs/kit';
import { calendarCaller, calendarFailure, readJson } from '#lib/server/calendar-http.ts';
import { updateCalendar } from '#lib/server/calendar-store.ts';
import { refreshOutsideCalendar, removeOutsideCalendar, setOutsideDetails } from '#lib/server/outside-calendars.ts';
import { outsideKey } from '#lib/server/outside-http.ts';

/** Refresh now. */
export const POST: RequestHandler = async ({ params, locals, platform }) => {
	const who = calendarCaller(locals, platform, { write: true });
	if ('response' in who) return who.response;
	const key = await outsideKey(platform);
	if ('response' in key) return key.response;
	try {
		return json(await refreshOutsideCalendar(who.db, key.key, who.userId, params.id ?? '', (url, init) => fetch(url, init)));
	} catch (error) {
		return calendarFailure(error);
	}
};

/** Rename, recolor, or switch between details and "Busy" only. */
export const PATCH: RequestHandler = async ({ params, request, locals, platform }) => {
	const who = calendarCaller(locals, platform, { write: true });
	if ('response' in who) return who.response;
	const body = await readJson(request);
	try {
		if (typeof body.details === 'boolean') await setOutsideDetails(who.db, who.userId, params.id ?? '', body.details);
		if (body.name !== undefined || body.color !== undefined) {
			await updateCalendar(who.db, who.userId, params.id ?? '', { name: body.name, color: body.color });
		}
		return json({ ok: true });
	} catch (error) {
		return calendarFailure(error);
	}
};

/** Stop copying it. The original calendar isn't touched. */
export const DELETE: RequestHandler = async ({ params, locals, platform }) => {
	const who = calendarCaller(locals, platform, { write: true });
	if ('response' in who) return who.response;
	try {
		await removeOutsideCalendar(who.db, who.userId, params.id ?? '');
		return json({ ok: true });
	} catch (error) {
		return calendarFailure(error);
	}
};
