import { json, type RequestHandler } from '@sveltejs/kit';
import { DEMO_MODE, DEMO_USER } from '#lib/server/demo.ts';

/**
 * One message's original headers, for "Show details". Fetched only when the
 * reader opens them, so a thread doesn't carry every message's headers.
 */
export const GET: RequestHandler = async ({ params, locals, platform }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (DEMO_MODE && locals.user.id === DEMO_USER.id) return json({ rawHeaders: null });

	const db = platform?.env.DB;
	if (!db) return json({ error: 'Unauthorized' }, { status: 401 });
	if (!params.id) return json({ error: 'Not found' }, { status: 404 });

	const row = await db
		.prepare(`SELECT raw_headers FROM emails WHERE id = ? AND user_id = ? AND direction = 'inbound'`)
		.bind(params.id, locals.user.id)
		.first<{ raw_headers: string | null }>();
	if (!row) return json({ error: 'Not found' }, { status: 404 });
	return json({ rawHeaders: row.raw_headers });
};
