import { json, type RequestHandler } from '@sveltejs/kit';
import { calendarCaller, calendarFailure, inviteProvider, readJson } from '#lib/server/calendar-http.ts';
import { createEvent, listCalendars, occurrencesInRange, seriesOf, setSendFrom } from '#lib/server/calendar-store.ts';
import { readGuests, replaceAttendees, sendInvites } from '#lib/server/calendar-invites.ts';

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

/** Create an event. With `guests`, they get an invite from `sendFrom` (or your default address). */
export const POST: RequestHandler = async ({ request, url, locals, platform }) => {
	const who = calendarCaller(locals, platform, { write: true });
	if ('response' in who) return who.response;
	const body = await readJson(request);
	const own = locals.addresses.map((address) => address.address);
	try {
		const guests = readGuests(body.guests, own);
		const sendFrom = typeof body.sendFrom === 'string' && own.includes(body.sendFrom) ? body.sendFrom : null;
		const id = await createEvent(who.db, who.userId, body, { uidDomain: url.hostname });
		let invites = null;
		if (guests.length) {
			await setSendFrom(who.db, id, sendFrom);
			await replaceAttendees(who.db, id, guests);
			const provider = inviteProvider(platform);
			invites = provider
				? await sendInvites(who.db, provider, locals.user!, await seriesOf(who.db, who.userId, id))
				: { sent: 0, error: 'Sending mail is not set up' };
		}
		return json({ id, invites }, { status: 201 });
	} catch (error) {
		return calendarFailure(error);
	}
};
