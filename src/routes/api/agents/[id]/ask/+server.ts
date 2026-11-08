import { json, type RequestHandler } from '@sveltejs/kit';
import { caller, failure, readBody } from '#lib/server/agents-http.ts';
import { enqueueAskRun } from '#lib/server/agent-runs-store.ts';

/** Ask an agent to help with a thread: { emailId, request }. The run starts within a minute. */
export const POST: RequestHandler = async ({ params, request, locals, platform }) => {
	const who = caller(locals, platform, { write: true });
	if ('response' in who) return who.response;

	const body = await readBody(request);
	const emailId = typeof body?.emailId === 'string' ? body.emailId : '';
	const text = typeof body?.request === 'string' ? body.request : '';
	if (!emailId) return json({ error: 'email' }, { status: 400 });

	try {
		const runId = await enqueueAskRun(who.db, {
			agentId: params.id ?? '',
			byUserId: who.userId,
			emailId,
			request: text
		});
		return json({ runId }, { status: 201 });
	} catch (error) {
		return failure(error);
	}
};
