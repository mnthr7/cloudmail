import { json, type RequestHandler } from '@sveltejs/kit';
import { calendarCaller, readJson } from '#lib/server/calendar-http.ts';
import { createBookingPage, listBookingPages } from '#lib/server/booking-store.ts';
import { bookingFailure } from '#lib/server/booking-http.ts';

/** Your booking pages. */
export const GET: RequestHandler = async ({ locals, platform }) => {
	const who = calendarCaller(locals, platform, { write: false });
	if ('response' in who) return who.response;
	return json({ pages: await listBookingPages(who.db, who.userId) });
};

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	const who = calendarCaller(locals, platform, { write: true });
	if ('response' in who) return who.response;
	const body = await readJson(request);
	const own = locals.addresses.map((address) => address.address.toLowerCase());
	try {
		return json({ page: await createBookingPage(who.db, who.userId, own, body) }, { status: 201 });
	} catch (error) {
		return bookingFailure(error);
	}
};
