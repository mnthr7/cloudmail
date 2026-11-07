import { json, type RequestHandler } from '@sveltejs/kit';
import { deleteDraft } from '#lib/server/mail-store.ts';

export const DELETE: RequestHandler = async ({ params, locals, platform }) => {
	const db = platform?.env.DB;
	if (!db || !locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	await deleteDraft(db, locals.user.id, params.id!);

	return json({ ok: true });
};
