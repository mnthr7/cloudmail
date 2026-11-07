import { json, type RequestHandler } from '@sveltejs/kit';
import { DEMO_MODE, DEMO_USER } from '#lib/server/demo.ts';
import {
	FilterNotFoundError,
	FilterWriteError,
	deleteFilter,
	parseFilterBody,
	updateFilter
} from '#lib/server/filters-store.ts';

/** Change a filter. Omitted fields stay as they are. The result must still have a condition and an action. */
export const PATCH: RequestHandler = async ({ params, request, locals, platform }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	// Demo mode is server-env only (DEMO_MODE="true"), never a URL param.
	if (DEMO_MODE && locals.user.id === DEMO_USER.id) {
		return json({ error: 'Demo mode is read-only' }, { status: 403 });
	}

	const db = platform?.env.DB;
	if (!db) return json({ error: 'Unauthorized' }, { status: 401 });

	const id = params.id;
	if (!id) return json({ error: 'Not found' }, { status: 404 });

	const body = await readBody(request);
	if (!body) return json({ error: 'Bad request' }, { status: 400 });

	const draft = parseFilterBody(body, 'patch');
	if (!draft) return json({ error: 'Bad request' }, { status: 400 });

	try {
		const filter = await updateFilter(db, locals.user.id, id, draft);
		return json({ filter });
	} catch (error) {
		return failure(error);
	}
};

/** Delete a filter. Mail it already filed stays where it is. */
export const DELETE: RequestHandler = async ({ params, locals, platform }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	// Demo mode is server-env only (DEMO_MODE="true"), never a URL param.
	if (DEMO_MODE && locals.user.id === DEMO_USER.id) {
		return json({ error: 'Demo mode is read-only' }, { status: 403 });
	}

	const db = platform?.env.DB;
	if (!db) return json({ error: 'Unauthorized' }, { status: 401 });

	const id = params.id;
	if (!id) return json({ error: 'Not found' }, { status: 404 });

	try {
		await deleteFilter(db, locals.user.id, id);
		return json({ ok: true });
	} catch (error) {
		return failure(error);
	}
};

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
	const body = (await request.json().catch(() => null)) as unknown;
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
	return body as Record<string, unknown>;
}

function failure(error: unknown): Response {
	if (error instanceof FilterWriteError) return json({ error: error.code }, { status: 400 });
	if (error instanceof FilterNotFoundError) return json({ error: 'Not found' }, { status: 404 });
	throw error;
}
