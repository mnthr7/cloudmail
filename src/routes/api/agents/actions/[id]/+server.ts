import { inviteProvider } from '#lib/server/calendar-http.ts';
import { json, type RequestHandler } from '@sveltejs/kit';
import { caller, failure, readBody } from '#lib/server/agents-http.ts';
import { decideAction } from '#lib/server/agents-store.ts';
import { executeAction } from '#lib/server/agent-executor.ts';

/**
 * Approve or decline a queued proposal. 409 if it was already decided or has
 * expired. Approving carries it out at once; `execution` says how that went.
 */
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
		const execution = status === 'approved' ? await executeAction(who.db, params.id ?? '', new Date(), { provider: inviteProvider(platform) }) : null;
		return json({ status: execution?.status === 'executed' ? 'executed' : status, execution });
	} catch (error) {
		return failure(error);
	}
};
