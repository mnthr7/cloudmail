import { json, type RequestHandler } from '@sveltejs/kit';
import { caller, failure, readBody } from '#lib/server/agents-http.ts';
import { createAgent } from '#lib/server/agents-store.ts';
import { avaDefinition, AVA_NAME } from '#lib/agents/ava.ts';
import { parseEmailAddress } from '#lib/email-address.ts';
import { BookingError, listBookingPages, updateBookingPage } from '#lib/server/booking-store.ts';

/**
 * Hire Ava at an address the user can send from (usually demo@), and hand her
 * a booking page: its invites then come from her address, so guests' replies
 * reach her. Like any new agent she starts in shadow mode.
 */
export const POST: RequestHandler = async ({ request, locals, platform, url }) => {
	const who = caller(locals, platform, { write: true });
	if ('response' in who) return who.response;
	const body = await readBody(request);
	const address = typeof body?.address === 'string' ? parseEmailAddress(body.address)?.toLowerCase() : '';
	if (!address) return json({ error: 'address' }, { status: 400 });
	const pageId = typeof body?.pageId === 'string' ? body.pageId : '';
	const own = locals.addresses.map((item) => item.address.toLowerCase());
	try {
		const pages = await listBookingPages(who.db, who.userId);
		if (pageId && !pages.some((page) => page.id === pageId)) return json({ error: 'page' }, { status: 400 });
		const company = locals.domains.find((domain) => address.endsWith(`@${domain.name}`))?.name ?? '';
		const agent = await createAgent(who.db, {
			ownerUserId: who.userId,
			displayName: AVA_NAME,
			definition: avaDefinition(address, company)
		});
		if (pageId) {
			await updateBookingPage(who.db, who.userId, own, pageId, { sendFrom: address });
			await who.db.prepare(`UPDATE booking_pages SET site_origin = ? WHERE id = ?`).bind(url.origin, pageId).run();
		}
		return json({ id: agent.id }, { status: 201 });
	} catch (error) {
		if (error instanceof BookingError) return json({ error: error.code }, { status: error.status });
		return failure(error);
	}
};
