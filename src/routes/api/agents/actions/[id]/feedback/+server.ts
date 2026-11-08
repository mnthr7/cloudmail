import { json, type RequestHandler } from '@sveltejs/kit';
import { caller, failure, readBody } from '#lib/server/agents-http.ts';
import { setActionFeedback } from '#lib/server/agent-runs-store.ts';

/** Thumbs up or down on a proposal: { feedback: 'up' | 'down' | null }. */
export const POST: RequestHandler = async ({ params, request, locals, platform }) => {
	const who = caller(locals, platform, { write: true });
	if ('response' in who) return who.response;

	const body = await readBody(request);
	const feedback = body?.feedback;
	if (feedback !== 'up' && feedback !== 'down' && feedback !== null) {
		return json({ error: 'feedback' }, { status: 400 });
	}

	try {
		await setActionFeedback(who.db, { actionId: params.id ?? '', byUserId: who.userId, feedback });
		return json({ ok: true });
	} catch (error) {
		return failure(error);
	}
};
