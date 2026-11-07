import { json, type RequestHandler } from '@sveltejs/kit';
import { caller, failure, readBody } from '$lib/server/agents-http';
import { createAgent, listAgents } from '$lib/server/agents-store';

/** Every agent in the workspace. */
export const GET: RequestHandler = async ({ locals, platform }) => {
	const who = caller(locals, platform, { write: false });
	if ('response' in who) return who.response;
	try {
		return json({ agents: await listAgents(who.db, who.userId) });
	} catch (error) {
		return failure(error);
	}
};

/** Hire an agent. It starts in shadow mode (A8) with the definition given. */
export const POST: RequestHandler = async ({ request, locals, platform }) => {
	const who = caller(locals, platform, { write: true });
	if ('response' in who) return who.response;

	const body = await readBody(request);
	const name = typeof body?.name === 'string' ? body.name.trim() : '';
	if (!body || !name || name.length > 80) return json({ error: 'name' }, { status: 400 });

	try {
		const agent = await createAgent(who.db, {
			ownerUserId: who.userId,
			displayName: name,
			definition: body.definition
		});
		return json({ agent }, { status: 201 });
	} catch (error) {
		return failure(error);
	}
};
