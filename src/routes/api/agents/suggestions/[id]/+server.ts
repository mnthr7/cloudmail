import { json, type RequestHandler } from '@sveltejs/kit';
import { caller } from '#lib/server/agents-http.ts';
import { dismissSuggestion, SuggestionError } from '#lib/server/reply-suggestions-store.ts';

/** DELETE dismisses an open set of suggested replies on the caller's own thread. */
export const DELETE: RequestHandler = async ({ params, locals, platform }) => {
	const who = caller(locals, platform, { write: true });
	if ('response' in who) return who.response;
	try {
		await dismissSuggestion(who.db, who.userId, params.id ?? '');
		return json({ dismissed: true });
	} catch (error) {
		if (error instanceof SuggestionError) return json({ error: 'Not found' }, { status: 404 });
		throw error;
	}
};
