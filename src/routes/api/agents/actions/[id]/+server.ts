import { json, type RequestHandler } from '@sveltejs/kit';
import { caller, failure, readBody } from '#lib/server/agents-http.ts';
import { decideAction } from '#lib/server/agents-store.ts';

/** Approve or decline a queued proposal. 409 if it was already decided or has expired. */
export const POST: RequestHandler = async ({ params, request, locals, platform }) => {
	const who = caller(locals, platform, { write: true });
	if ('response' in who) return who.response;

	const body = await readBody(request);
	const decision = body?.decision;
	if (decision !== 'approve' && decision !== 'decline') {
		return json({ error: 'decision' }, { status: 400 });
	}
	const note = typeof body?.note === 'string' && body.note.trim() ? body.note.trim() : undefined;

	try {
		const status = await decideAction(who.db, {
			actionId: params.id ?? '',
			byUserId: who.userId,
			decision,
			note
		});
		return json({ status });
	} catch (error) {
		return failure(error);
	}
};
