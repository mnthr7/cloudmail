import { json, type RequestHandler } from '@sveltejs/kit';
import { calendarCaller, calendarFailure, readJson } from '#lib/server/calendar-http.ts';
import { deleteEvent, updateEvent } from '#lib/server/calendar-store.ts';

/** Edit an event. With `occurrence`, only that occurrence of a repeating event changes. */
export const PATCH: RequestHandler = async ({ params, request, locals, platform }) => {
	const who = calendarCaller(locals, platform, { write: true });
	if ('response' in who) return who.response;
	const body = await readJson(request);
	try {
		const id = await updateEvent(who.db, who.userId, params.id ?? '', body);
		return json({ id });
	} catch (error) {
		return calendarFailure(error);
	}
};

/** Delete an event. `?occurrence=` removes only that occurrence of a repeating event. */
export const DELETE: RequestHandler = async ({ params, url, locals, platform }) => {
	const who = calendarCaller(locals, platform, { write: true });
	if ('response' in who) return who.response;
	const occurrence = url.searchParams.get('occurrence') ?? undefined;
	try {
		await deleteEvent(who.db, who.userId, params.id ?? '', occurrence);
		return json({ ok: true });
	} catch (error) {
		return calendarFailure(error);
	}
};
