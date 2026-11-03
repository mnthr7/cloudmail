import { json, type RequestHandler } from '@sveltejs/kit';
import { DEMO_USER } from '$lib/server/demo';
import { saveSignature } from '$lib/server/signatures';

export const PUT: RequestHandler = async ({ params, request, locals, platform }) => {
	const db = platform?.env.DB;
	if (!db || !locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	if (locals.user.id === DEMO_USER.id) {
		return json({ error: 'Demo mode is read-only' }, { status: 403 });
	}

	const body = (await request.json().catch(() => null)) as { html?: unknown } | null;
	if (!body || typeof body.html !== 'string') {
		return json({ error: 'html must be a string' }, { status: 400 });
	}

	const saved = await saveSignature(db, locals.user.id, params.id!, body.html);
	if (!saved) {
		return json({ error: 'Address not found' }, { status: 404 });
	}

	return json({ ok: true });
};
