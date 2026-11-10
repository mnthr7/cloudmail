import { json, type RequestHandler } from '@sveltejs/kit';
import { calendarCaller, calendarFailure, inviteProvider, readJson } from '#lib/server/calendar-http.ts';
import { respondToInvite, type InviteResponse } from '#lib/server/calendar-invites.ts';

const RESPONSES: InviteResponse[] = ['ACCEPTED', 'TENTATIVE', 'DECLINED'];

/** Answer an invite: Yes or Maybe puts it on your calendar, No takes it off; the organizer gets your RSVP. */
export const POST: RequestHandler = async ({ params, request, locals, platform }) => {
	const who = calendarCaller(locals, platform, { write: true });
	if ('response' in who) return who.response;
	const body = await readJson(request);
	const response = body.response as InviteResponse;
	if (!RESPONSES.includes(response)) return json({ error: 'response' }, { status: 400 });
	try {
		const result = await respondToInvite(
			who.db,
			inviteProvider(platform),
			locals.user!,
			locals.addresses.map((address) => address.address),
			params.id ?? '',
			response
		);
		return json(result);
	} catch (error) {
		return calendarFailure(error);
	}
};
