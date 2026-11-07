import { json, type RequestHandler } from '@sveltejs/kit';
import { caller, failure } from '$lib/server/agents-http';
import { pauseAllAgents } from '$lib/server/agents-store';

/** The kill switch: every agent in the workspace stops at once (A10). */
export const POST: RequestHandler = async ({ locals, platform }) => {
	const who = caller(locals, platform, { write: true });
	if ('response' in who) return who.response;
	try {
		return json({ paused: await pauseAllAgents(who.db, who.userId) });
	} catch (error) {
		return failure(error);
	}
};
