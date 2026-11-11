import { json, type RequestHandler } from '@sveltejs/kit';
import { calendarCaller, readJson } from '#lib/server/calendar-http.ts';
import { deleteBookingPage, updateBookingPage } from '#lib/server/booking-store.ts';
import { bookingFailure } from '#lib/server/booking-http.ts';

export const PATCH: RequestHandler = async ({ params, request, locals, platform }) => {
	const who = calendarCaller(locals, platform, { write: true });
	if ('response' in who) return who.response;
	const body = await readJson(request);
	const own = locals.addresses.map((address) => address.address.toLowerCase());
	try {
		return json({ page: await updateBookingPage(who.db, who.userId, own, params.id ?? '', body) });
	} catch (error) {
		return bookingFailure(error);
	}
};

export const DELETE: RequestHandler = async ({ params, locals, platform }) => {
	const who = calendarCaller(locals, platform, { write: true });
	if ('response' in who) return who.response;
	try {
		await deleteBookingPage(who.db, who.userId, params.id ?? '');
		return json({ ok: true });
	} catch (error) {
		return bookingFailure(error);
	}
};
