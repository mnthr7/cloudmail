import { json, type RequestHandler } from '@sveltejs/kit';
import { caller, failure } from '$lib/server/agents-http';
import { listQueuedActions } from '$lib/server/agents-store';

/** The Needs your OK queue (A7), oldest first. */
export const GET: RequestHandler = async ({ locals, platform }) => {
	const who = caller(locals, platform, { write: false });
	if ('response' in who) return who.response;
	try {
		return json({ actions: await listQueuedActions(who.db, who.userId) });
	} catch (error) {
		return failure(error);
	}
};
