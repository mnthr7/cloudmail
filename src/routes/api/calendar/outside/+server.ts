import { json, type RequestHandler } from '@sveltejs/kit';
import { calendarCaller, calendarFailure, readJson } from '#lib/server/calendar-http.ts';
import { isTimeZone } from '#lib/calendar/time.ts';
import { addOutsideCalendar } from '#lib/server/outside-calendars.ts';
import { outsideKey } from '#lib/server/outside-http.ts';

/** Add an outside calendar by its secret iCal link (Google, iCloud, Outlook). */
export const POST: RequestHandler = async ({ request, locals, platform }) => {
	const who = calendarCaller(locals, platform, { write: true });
	if ('response' in who) return who.response;
	const key = await outsideKey(platform);
	if ('response' in key) return key.response;
	const body = await readJson(request);
	const timezone = typeof body.timezone === 'string' ? body.timezone : 'UTC';
	try {
		const result = await addOutsideCalendar(
			who.db,
			key.key,
			who.userId,
			{ url: body.url, name: body.name, color: body.color, details: body.details, timezone: isTimeZone(timezone) ? timezone : 'UTC' },
			(url, init) => fetch(url, init)
		);
		return json(result, { status: 201 });
	} catch (error) {
		return calendarFailure(error);
	}
};
