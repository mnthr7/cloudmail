import { json, type RequestHandler } from '@sveltejs/kit';
import { caller, failure, readBody } from '#lib/server/agents-http.ts';
import { enqueueAskRun } from '#lib/server/agent-runs-store.ts';
import { humanPrincipalForUser } from '#lib/server/agents-store.ts';
import { startAgentsNow } from '#lib/server/start-agents.ts';

/**
 * Ask an agent to help with a thread: { emailId, request }. Without a request
 * ({ emailId, suggest: true }), it suggests replies. The run starts at once.
 */
export const POST: RequestHandler = async ({ params, request, locals, platform }) => {
	const who = caller(locals, platform, { write: true });
	if ('response' in who) return who.response;

	const body = await readBody(request);
	const emailId = typeof body?.emailId === 'string' ? body.emailId : '';
	const text = body?.suggest === true ? null : typeof body?.request === 'string' ? body.request : '';
	if (!emailId) return json({ error: 'email' }, { status: 400 });

	try {
		const runId = await enqueueAskRun(who.db, {
			agentId: params.id ?? '',
			byUserId: who.userId,
			emailId,
			request: text
		});
		startAgentsNow(platform, (await humanPrincipalForUser(who.db, who.userId)).workspace_id);
		return json({ runId }, { status: 201 });
	} catch (error) {
		return failure(error);
	}
};
