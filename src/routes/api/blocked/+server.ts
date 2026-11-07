import { json, type RequestHandler } from '@sveltejs/kit';
import { DEMO_MODE, DEMO_USER } from '#lib/server/demo.ts';
import { listBlockedSenders, removeBlockedSender } from '#lib/server/filters-store.ts';

/** Blocked mailbox addresses for the signed-in user. */
export const GET: RequestHandler = async ({ locals, platform }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	// Demo mode is server-env only (DEMO_MODE="true"), never a URL param.
	if (DEMO_MODE && locals.user.id === DEMO_USER.id) {
		return json([]);
	}

	const db = platform?.env.DB;
	if (!db) return json({ error: 'Unauthorized' }, { status: 401 });

	return json(await listBlockedSenders(db, locals.user.id));
};

/** Remove one blocked address. The body is `{ address }`. */
export const DELETE: RequestHandler = async ({ request, locals, platform }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	// Demo mode is server-env only (DEMO_MODE="true"), never a URL param.
	if (DEMO_MODE && locals.user.id === DEMO_USER.id) {
		return json({ error: 'Demo mode is read-only' }, { status: 403 });
	}

	const db = platform?.env.DB;
	if (!db) return json({ error: 'Unauthorized' }, { status: 401 });

	const body = await readBody(request);
	if (!body || typeof body.address !== 'string') {
		return json({ error: 'Bad request' }, { status: 400 });
	}

	const removed = await removeBlockedSender(db, locals.user.id, body.address);
	if (!removed) return json({ error: 'Bad request' }, { status: 400 });
	return json({ ok: true });
};

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
	const body = (await request.json().catch(() => null)) as unknown;
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
	return body as Record<string, unknown>;
}
