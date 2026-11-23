import { json, type RequestHandler } from '@sveltejs/kit';
import { ALL_DOMAINS, addDoNotSend, listDoNotSend, removeDoNotSend } from '#lib/server/do-not-send.ts';

/** The do-not-send list: who marketing (and, for bounces, any) mail won't go to. Admins only. */
export const GET: RequestHandler = async ({ locals, platform }) => {
	if (!locals.user?.is_admin) return json({ error: 'Forbidden' }, { status: 403 });
	const db = platform?.env.DB;
	if (!db) return json({ error: 'Database unavailable' }, { status: 503 });
	return json({ entries: await listDoNotSend(db) });
};

/** Block an address by hand, for every domain (`scope: "*"`) or one connected domain. */
export const POST: RequestHandler = async ({ request, locals, platform }) => {
	if (!locals.user?.is_admin) return json({ error: 'Forbidden' }, { status: 403 });
	const db = platform?.env.DB;
	if (!db) return json({ error: 'Database unavailable' }, { status: 503 });

	const body = (await request.json().catch(() => ({}))) as { address?: string; scope?: string; detail?: string };
	const address = body.address?.trim() ?? '';
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
		return json({ error: 'Enter an email address' }, { status: 400 });
	}
	const scope = body.scope?.trim() || ALL_DOMAINS;
	if (scope !== ALL_DOMAINS && !locals.domains.some((domain) => domain.name === scope)) {
		return json({ error: 'Pick a connected domain, or all domains' }, { status: 400 });
	}
	await addDoNotSend(db, { address, scope, reason: 'manual', detail: body.detail?.trim() || null });
	return json({ ok: true });
};

/** Take an address off the list (?id=). It can get mail again. */
export const DELETE: RequestHandler = async ({ url, locals, platform }) => {
	if (!locals.user?.is_admin) return json({ error: 'Forbidden' }, { status: 403 });
	const db = platform?.env.DB;
	if (!db) return json({ error: 'Database unavailable' }, { status: 503 });
	const id = url.searchParams.get('id');
	if (!id) return json({ error: 'id is required' }, { status: 400 });
	const removed = await removeDoNotSend(db, id);
	return removed ? json({ ok: true }) : json({ error: 'Not found' }, { status: 404 });
};
