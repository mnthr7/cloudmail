import { json, type RequestHandler } from '@sveltejs/kit';
import { bookSlot } from '#lib/server/booking-store.ts';
import { bookingFailure, visitorAddress, visitorKeys } from '#lib/server/booking-http.ts';
import { inviteProvider, readJson } from '#lib/server/calendar-http.ts';
import { clientNetwork, reserveLoginAttempt } from '#lib/server/login-limit.ts';
import { DEMO_MODE } from '#lib/server/demo.ts';

/** Public: book a time on a booking page. */
export const POST: RequestHandler = async ({ params, request, url, platform, getClientAddress }) => {
	const db = platform?.env.DB;
	if (!db) return json({ error: 'missing' }, { status: 404 });
	if (DEMO_MODE) return json({ error: 'missing' }, { status: 404 });
	// A few tries per network every 15 minutes, so the page can't be used to send invites in bulk.
	const network = clientNetwork(visitorAddress(request, getClientAddress));
	const wait = await reserveLoginAttempt(db, visitorKeys('book', network, 5), new Date());
	if (wait !== null) return json({ error: 'slow_down', retryAfter: wait }, { status: 429 });
	const body = await readJson(request);
	try {
		const result = await bookSlot(
			db,
			inviteProvider(platform),
			params.slug ?? '',
			{ start: body.start, duration: body.duration, name: body.name, email: body.email, note: body.note },
			{ uidDomain: url.hostname }
		);
		return json(result, { status: 201 });
	} catch (error) {
		return bookingFailure(error);
	}
};
