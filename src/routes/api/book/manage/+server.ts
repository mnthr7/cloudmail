import { json, type RequestHandler } from '@sveltejs/kit';
import { cancelBooking, manageSlots, manageView, rescheduleBooking } from '#lib/server/booking-manage.ts';
import { bookingFailure, visitorAddress, visitorKeys } from '#lib/server/booking-http.ts';
import { inviteProvider, readJson } from '#lib/server/calendar-http.ts';
import { clientNetwork, reserveLoginAttempt } from '#lib/server/login-limit.ts';
import { DEMO_MODE } from '#lib/server/demo.ts';

/**
 * Public, with the private link's token in the body (never in a URL, so it
 * stays out of logs): { token, action: "view" | "slots" | "reschedule" | "cancel" }.
 */
export const POST: RequestHandler = async ({ request, url, platform, getClientAddress }) => {
	const db = platform?.env.DB;
	if (!db || DEMO_MODE) return json({ error: 'missing' }, { status: 404 });
	const body = await readJson(request);
	const changing = body.action === 'reschedule' || body.action === 'cancel';
	const network = clientNetwork(visitorAddress(request, getClientAddress));
	const wait = await reserveLoginAttempt(db, visitorKeys(changing ? 'manage' : 'slots', network, changing ? 10 : 120), new Date());
	if (wait !== null) return json({ error: 'slow_down', retryAfter: wait }, { status: 429 });
	const headers = { 'Cache-Control': 'no-store' };
	try {
		switch (body.action) {
			case 'view': {
				const view = await manageView(db, body.token);
				return view ? json(view, { headers }) : json({ error: 'missing' }, { status: 404, headers });
			}
			case 'slots': {
				const from = Date.parse(String(body.from ?? ''));
				const to = Date.parse(String(body.to ?? ''));
				if (!Number.isFinite(from) || !Number.isFinite(to)) return json({ error: 'range' }, { status: 400 });
				const slots = await manageSlots(db, body.token, { from, to });
				return json(
					{ slots: slots.map((slot) => ({ start: new Date(slot.start).toISOString(), end: new Date(slot.end).toISOString() })) },
					{ headers }
				);
			}
			case 'cancel':
				await cancelBooking(db, inviteProvider(platform), body.token, body.reason);
				return json({ ok: true }, { headers });
			case 'reschedule':
				return json(await rescheduleBooking(db, inviteProvider(platform), body.token, body.start, { origin: url.origin }), { headers });
			default:
				return json({ error: 'action' }, { status: 400 });
		}
	} catch (error) {
		return bookingFailure(error);
	}
};
