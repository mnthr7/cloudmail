import { json, type RequestHandler } from '@sveltejs/kit';
import { caller, failure, readBody } from '#lib/server/agents-http.ts';
import { deleteMemory, updateMemory } from '#lib/server/agent-memory-store.ts';

/** Edit a fact. */
export const PATCH: RequestHandler = async ({ params, request, locals, platform }) => {
	const who = caller(locals, platform, { write: true });
	if ('response' in who) return who.response;
	const body = await readBody(request);
	try {
		await updateMemory(who.db, { agentId: params.id ?? '', factId: params.factId ?? '', fact: body?.fact, byUserId: who.userId });
		return json({ ok: true });
	} catch (error) {
		return failure(error);
	}
};

/** Forget a fact. */
export const DELETE: RequestHandler = async ({ params, locals, platform }) => {
	const who = caller(locals, platform, { write: true });
	if ('response' in who) return who.response;
	try {
		await deleteMemory(who.db, { agentId: params.id ?? '', factId: params.factId ?? '', byUserId: who.userId });
		return json({ ok: true });
	} catch (error) {
		return failure(error);
	}
};
