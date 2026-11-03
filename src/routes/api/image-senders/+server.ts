import { json, type RequestHandler } from '@sveltejs/kit';
import { DEMO_USER } from '$lib/server/demo';
import { forgetImageSender, rememberImageSender } from '$lib/server/image-senders';

/** Save a From address whose remote images may load. The body is `{ address }`. */
export const POST: RequestHandler = async ({ request, locals, platform }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const address = await readAddress(request);
	if (!address) return json({ error: 'address' }, { status: 400 });
	if (locals.user.id === DEMO_USER.id) {
		return json({ error: 'Demo mode is read-only' }, { status: 403 });
	}

	const db = platform?.env.DB;
	if (!db) return json({ error: 'Unauthorized' }, { status: 401 });

	const saved = await rememberImageSender(db, locals.user.id, address);
	if (!saved) return json({ error: 'address' }, { status: 400 });
	return json({ ok: true });
};

/** Remove one saved image sender. The body is `{ address }`. */
export const DELETE: RequestHandler = async ({ request, locals, platform }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const address = await readAddress(request);
	if (!address) return json({ error: 'address' }, { status: 400 });
	if (locals.user.id === DEMO_USER.id) {
		return json({ error: 'Demo mode is read-only' }, { status: 403 });
	}

	const db = platform?.env.DB;
	if (!db) return json({ error: 'Unauthorized' }, { status: 401 });

	await forgetImageSender(db, locals.user.id, address);
	return json({ ok: true });
};

async function readAddress(request: Request): Promise<string | null> {
	const body = (await request.json().catch(() => null)) as { address?: unknown } | null;
	if (!body || typeof body.address !== 'string') return null;
	const trimmed = body.address.trim();
	if (!trimmed.includes('@')) return null;
	return body.address;
}
