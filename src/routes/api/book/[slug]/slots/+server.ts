import { json, type RequestHandler } from '@sveltejs/kit';
import { openSlots } from '#lib/server/booking-store.ts';
import { bookingFailure, visitorAddress, visitorKeys } from '#lib/server/booking-http.ts';
import { clientNetwork, reserveLoginAttempt } from '#lib/server/login-limit.ts';

/** Public: open times on a booking page between `from` and `to` (ISO instants). */
export const GET: RequestHandler = async ({ params, url, platform, request, getClientAddress }) => {
	const db = platform?.env.DB;
	if (!db) return json({ error: 'missing' }, { status: 404 });
	// Each look reads the whole calendar, so a visitor gets a sensible number of them.
	const network = clientNetwork(visitorAddress(request, getClientAddress));
	const wait = await reserveLoginAttempt(db, visitorKeys('slots', network, 120), new Date());
	if (wait !== null) return json({ error: 'slow_down', retryAfter: wait }, { status: 429 });
	const from = Date.parse(url.searchParams.get('from') ?? '');
	const to = Date.parse(url.searchParams.get('to') ?? '');
	const duration = Number(url.searchParams.get('duration'));
	if (!Number.isFinite(from) || !Number.isFinite(to)) return json({ error: 'range' }, { status: 400 });
	try {
		const slots = await openSlots(db, params.slug ?? '', { from, to, duration });
		return json(
			{ slots: slots.map((slot) => ({ start: new Date(slot.start).toISOString(), end: new Date(slot.end).toISOString() })) },
			{ headers: { 'Cache-Control': 'no-store' } }
		);
	} catch (error) {
		return bookingFailure(error);
	}
};
