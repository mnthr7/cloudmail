import { json, type RequestHandler } from '@sveltejs/kit';
import { caller, failure, readBody } from '#lib/server/agents-http.ts';
import { addMemory, listMemory } from '#lib/server/agent-memory-store.ts';
import { getAgentForUser } from '#lib/server/agents-store.ts';

/** The agent's memory: every fact it knows. */
export const GET: RequestHandler = async ({ params, locals, platform }) => {
	const who = caller(locals, platform, { write: false });
	if ('response' in who) return who.response;
	try {
		const agent = await getAgentForUser(who.db, params.id ?? '', who.userId);
		return json({ facts: await listMemory(who.db, agent.id) });
	} catch (error) {
		return failure(error);
	}
};

/** Add a fact by hand. Only someone who can change the agent may. */
export const POST: RequestHandler = async ({ params, request, locals, platform }) => {
	const who = caller(locals, platform, { write: true });
	if ('response' in who) return who.response;
	const body = await readBody(request);
	try {
		const fact = await addMemory(who.db, {
			agentId: params.id ?? '',
			fact: body?.fact,
			source: 'founder',
			byUserId: who.userId
		});
		return json({ fact }, { status: 201 });
	} catch (error) {
		return failure(error);
	}
};
