import { json, type RequestHandler } from '@sveltejs/kit';
import { caller, failure, readBody } from '#lib/server/agents-http.ts';
import { answerCheck } from '#lib/server/no-show.ts';

/**
 * Your answer to "Did they show?" (R13): `showed` or `no_show`. Only the
 * meeting's host can answer, once. A no-show queues a "sorry we missed you"
 * email for your OK. 409 if it was already answered or has expired.
 */
export const POST: RequestHandler = async ({ params, request, locals, platform }) => {
	const who = caller(locals, platform, { write: true });
	if ('response' in who) return who.response;
	const body = await readBody(request);
	try {
		return json(await answerCheck(who.db, { checkId: params.id ?? '', userId: who.userId, answer: body?.answer }));
	} catch (error) {
		return failure(error);
	}
};
