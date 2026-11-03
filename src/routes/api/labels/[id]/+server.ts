import { json, type RequestHandler } from '@sveltejs/kit';
import { DEMO_MODE, DEMO_USER } from '$lib/server/demo';
import {
	LabelNotFoundError,
	LabelWriteError,
	deleteLabel,
	updateLabel
} from '$lib/server/labels-store';

/** Rename, recolor, or move a label. Omitted fields stay as they are. */
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

	const parent = readParent(body);
	if (parent === invalid) return json({ error: 'parent' }, { status: 400 });

	try {
		const label = await updateLabel(db, locals.user.id, id, {
			...(typeof body.name === 'string' ? { name: body.name } : {}),
			...(body.name !== undefined && typeof body.name !== 'string' ? { name: '' } : {}),
			...(parent === omitted ? {} : { parentId: parent }),
			...(body.color !== undefined
				? { color: typeof body.color === 'string' ? body.color : '' }
				: {})
		});
		return json({ label });
	} catch (error) {
		return failure(error);
	}
};

/** Delete a label. Sublabels and thread memberships cascade. Messages stay in All Mail. */
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
		await deleteLabel(db, locals.user.id, id);
		return json({ ok: true });
	} catch (error) {
		return failure(error);
	}
};

const invalid = Symbol('invalid-parent');
const omitted = Symbol('omitted-parent');

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
	const body = (await request.json().catch(() => null)) as unknown;
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
	return body as Record<string, unknown>;
}

function readParent(
	body: Record<string, unknown>
): string | null | typeof invalid | typeof omitted {
	if (!Object.prototype.hasOwnProperty.call(body, 'parentId')) return omitted;
	const value = body.parentId;
	if (value === null) return null;
	if (typeof value === 'string' && value.length > 0) return value;
	return invalid;
}

function failure(error: unknown): Response {
	if (error instanceof LabelWriteError) return json({ error: error.code }, { status: 400 });
	if (error instanceof LabelNotFoundError) return json({ error: 'Not found' }, { status: 404 });
	throw error;
}
