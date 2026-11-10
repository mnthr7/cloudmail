import { json, type RequestHandler } from '@sveltejs/kit';
import { calendarCaller, calendarFailure } from '#lib/server/calendar-http.ts';
import { removeFeedToken, rotateFeedToken } from '#lib/server/calendar-store.ts';

/**
 * Turn on (or replace) the secret subscribe link. The link is shown once;
 * making a new one stops the old one working.
 */
export const POST: RequestHandler = async ({ params, url, locals, platform }) => {
	const who = calendarCaller(locals, platform, { write: true });
	if ('response' in who) return who.response;
	try {
		const token = await rotateFeedToken(who.db, who.userId, params.id ?? '');
		const link = `${url.origin}/api/calendar/feed/${token}.ics`;
		return json({ link, webcal: link.replace(/^https?:/, 'webcal:') });
	} catch (error) {
		return calendarFailure(error);
	}
};

/** Turn the subscribe link off. */
export const DELETE: RequestHandler = async ({ params, locals, platform }) => {
	const who = calendarCaller(locals, platform, { write: true });
	if ('response' in who) return who.response;
	try {
		await removeFeedToken(who.db, who.userId, params.id ?? '');
		return json({ ok: true });
	} catch (error) {
		return calendarFailure(error);
	}
};
