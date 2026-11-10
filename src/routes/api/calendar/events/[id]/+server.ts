import { json, type RequestHandler } from '@sveltejs/kit';
import { calendarCaller, calendarFailure, inviteProvider, readJson } from '#lib/server/calendar-http.ts';
import { deleteEvent, editedOccurrences, seriesOf, setSendFrom, updateEvent } from '#lib/server/calendar-store.ts';
import { listAttendees, readGuests, replaceAttendees, sendInvites, type Guest } from '#lib/server/calendar-invites.ts';

/** An event's guests and who invites go out from, for the editor. */
export const GET: RequestHandler = async ({ params, locals, platform }) => {
	const who = calendarCaller(locals, platform, { write: false });
	if ('response' in who) return who.response;
	try {
		const series = await seriesOf(who.db, who.userId, params.id ?? '');
		return json({ attendees: await listAttendees(who.db, series.id), sendFrom: series.send_from });
	} catch (error) {
		return calendarFailure(error);
	}
};

/**
 * Edit an event. With `occurrence`, only that occurrence of a repeating event
 * changes. `guests` replaces the guest list. Guests get the update; removed
 * guests get a cancellation.
 */
export const PATCH: RequestHandler = async ({ params, request, locals, platform }) => {
	const who = calendarCaller(locals, platform, { write: true });
	if ('response' in who) return who.response;
	const body = await readJson(request);
	const own = locals.addresses.map((address) => address.address);
	try {
		const guests = body.guests === undefined ? null : readGuests(body.guests, own);
		const id = await updateEvent(who.db, who.userId, params.id ?? '', body);
		const series = await seriesOf(who.db, who.userId, id);
		let removed: Guest[] = [];
		if (!series.organizer_email) {
			if (typeof body.sendFrom === 'string' && own.includes(body.sendFrom)) await setSendFrom(who.db, series.id, body.sendFrom);
			if (guests) removed = (await replaceAttendees(who.db, series.id, guests)).removed;
		}
		const provider = inviteProvider(platform);
		const current = await seriesOf(who.db, who.userId, series.id);
		const hasGuests = !current.organizer_email && ((await listAttendees(who.db, current.id)).length > 0 || removed.length > 0);
		const invites = provider
			? await sendInvites(who.db, provider, locals.user!, current, { removed })
			: hasGuests
				? { sent: 0, error: 'Sending mail is not set up' }
				: null;
		return json({ id, invites });
	} catch (error) {
		return calendarFailure(error);
	}
};

/**
 * Delete an event. `?occurrence=` removes only that occurrence of a repeating
 * event (guests get the updated invite); deleting it all sends them a cancellation.
 */
export const DELETE: RequestHandler = async ({ params, url, locals, platform }) => {
	const who = calendarCaller(locals, platform, { write: true });
	if ('response' in who) return who.response;
	const occurrence = url.searchParams.get('occurrence') ?? undefined;
	try {
		const series = await seriesOf(who.db, who.userId, params.id ?? '');
		const wholeSeries = occurrence === undefined && series.id === params.id;
		// Who to tell, read before the rows go.
		const attendees = await listAttendees(who.db, series.id);
		const edits = wholeSeries ? await editedOccurrences(who.db, series.id) : [];
		await deleteEvent(who.db, who.userId, params.id ?? '', occurrence);
		const provider = inviteProvider(platform);
		let invites = null;
		if (attendees.length && !series.organizer_email) {
			invites = !provider
				? { sent: 0, error: 'Sending mail is not set up' }
				: wholeSeries
					? await sendInvites(who.db, provider, locals.user!, series, { cancelAll: true, attendees, edits })
					: await sendInvites(who.db, provider, locals.user!, await seriesOf(who.db, who.userId, series.id));
		}
		return json({ ok: true, invites });
	} catch (error) {
		return calendarFailure(error);
	}
};
