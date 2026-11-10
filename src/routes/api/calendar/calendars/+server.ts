import { json, type RequestHandler } from '@sveltejs/kit';
import { calendarCaller, calendarFailure, readJson } from '#lib/server/calendar-http.ts';
import { createCalendar, ensureCalendars } from '#lib/server/calendar-store.ts';

/** The user's calendars. `?timezone=` makes their first one in that zone if they have none. */
export const GET: RequestHandler = async ({ url, locals, platform }) => {
	const who = calendarCaller(locals, platform, { write: false });
	if ('response' in who) return who.response;
	try {
		const timezone = url.searchParams.get('timezone') || 'UTC';
		const calendars = await ensureCalendars(who.db, who.userId, { name: locals.user?.name || 'Calendar', timezone });
		// Your addresses, for choosing where invites go out from.
		return json({ calendars, addresses: locals.addresses.map((address) => address.address) });
	} catch (error) {
		return calendarFailure(error);
	}
};

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	const who = calendarCaller(locals, platform, { write: true });
	if ('response' in who) return who.response;
	const body = await readJson(request);
	try {
		const calendar = await createCalendar(who.db, who.userId, { name: body.name, timezone: body.timezone, color: body.color });
		return json({ calendar }, { status: 201 });
	} catch (error) {
		return calendarFailure(error);
	}
};
