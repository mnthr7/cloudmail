import { json, type RequestHandler } from '@sveltejs/kit';
import { undoScheduled } from '#lib/server/outbox-schedule.ts';

/** Undo and cancel. A row that was already claimed comes back as sent. */
export const POST: RequestHandler = async ({ params, locals, platform }) => {
	const db = platform?.env.DB;
	if (!locals.user || !db) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const status = await undoScheduled(db, params.id!, locals.user.id);
	return json({ status });
};
