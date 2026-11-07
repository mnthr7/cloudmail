import { json, type RequestHandler } from '@sveltejs/kit';
import { DEMO_MODE, DEMO_USER } from '#lib/server/demo.ts';
import {
	FilterWriteError,
	createFilter,
	listFilters,
	parseFilterBody
} from '#lib/server/filters-store.ts';

/** The signed-in user's filters, in the order new mail runs them. */
export const GET: RequestHandler = async ({ locals, platform }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	// Demo mode is server-env only (DEMO_MODE="true"), never a URL param.
	if (DEMO_MODE && locals.user.id === DEMO_USER.id) {
		return json({ filters: [] });
	}

	const db = platform?.env.DB;
	if (!db) return json({ error: 'Unauthorized' }, { status: 401 });

	return json({ filters: await listFilters(db, locals.user.id) });
};

/** Save a filter. Position is the next number for this user. At least one condition and one action. */
export const POST: RequestHandler = async ({ request, locals, platform }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	// Demo mode is server-env only (DEMO_MODE="true"), never a URL param.
	if (DEMO_MODE && locals.user.id === DEMO_USER.id) {
		return json({ error: 'Demo mode is read-only' }, { status: 403 });
	}

	const db = platform?.env.DB;
	if (!db) return json({ error: 'Unauthorized' }, { status: 401 });

	const body = await readBody(request);
	if (!body) return json({ error: 'Bad request' }, { status: 400 });

	const draft = parseFilterBody(body, 'create');
	if (!draft) return json({ error: 'Bad request' }, { status: 400 });

	try {
		const filter = await createFilter(db, locals.user.id, draft);
		return json({ filter }, { status: 201 });
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
	throw error;
}
