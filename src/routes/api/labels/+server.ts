import { json, type RequestHandler } from '@sveltejs/kit';
import { DEMO_LABELS, DEMO_MODE, DEMO_USER } from '#lib/server/demo.ts';
import {
	LabelNotFoundError,
	LabelWriteError,
	createLabel,
	listLabels
} from '#lib/server/labels-store.ts';

/** The signed-in user's labels, including nested ones and unread counts. */
export const GET: RequestHandler = async ({ locals, platform }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	// Demo mode is server-env only (DEMO_MODE="true"), never a URL param.
	if (DEMO_MODE && locals.user.id === DEMO_USER.id) {
		return json({ labels: DEMO_LABELS });
	}

	const db = platform?.env.DB;
	if (!db) return json({ error: 'Unauthorized' }, { status: 401 });

	return json({ labels: await listLabels(db, locals.user.id) });
};

/** Create a label. `parentId` null is a root. Invalid color, name, or parent is 400. */
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

	const parentId = readParent(body.parentId);
	if (parentId === invalid) return json({ error: 'parent' }, { status: 400 });

	try {
		const label = await createLabel(db, locals.user.id, {
			name: typeof body.name === 'string' ? body.name : '',
			parentId,
			color: typeof body.color === 'string' ? body.color : ''
		});
		return json({ label }, { status: 201 });
	} catch (error) {
		return failure(error);
	}
};

const invalid = Symbol('invalid-parent');

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
	const body = (await request.json().catch(() => null)) as unknown;
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
	return body as Record<string, unknown>;
}

/** A missing parent is the root. Anything other than null or a non-empty string is rejected. */
function readParent(value: unknown): string | null | typeof invalid {
	if (value === undefined || value === null) return null;
	if (typeof value === 'string' && value.length > 0) return value;
	return invalid;
}

function failure(error: unknown): Response {
	if (error instanceof LabelWriteError) return json({ error: error.code }, { status: 400 });
	if (error instanceof LabelNotFoundError) return json({ error: 'Not found' }, { status: 404 });
	throw error;
}
