import { json, type RequestHandler } from '@sveltejs/kit';
import { getEmailProvider } from '$lib/server/context';
import { DEMO_MODE, DEMO_USER } from '$lib/server/demo';
import type { EmailProvider } from '$lib/server/email-provider';
import { ConfigError } from '$lib/server/errors';
import {
	FilterNotFoundError,
	FilterWriteError,
	applySavedFilter
} from '$lib/server/filters-store';

/**
 * Apply one saved filter to mail already filed.
 * `{ dryRun: true }` returns `{ matched }` and writes nothing.
 * Any other POST runs the actions and returns `{ changed, forwardFailed }`.
 * Both `matched` and `changed` count conversations. A forward that fails is counted and does not throw.
 * Running apply again sends another copy of each forward.
 */
export const POST: RequestHandler = async ({ params, request, locals, platform }) => {
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
	if (body === 'invalid') return json({ error: 'Bad request' }, { status: 400 });

	try {
		if (body?.dryRun === true) {
			const preview = await applySavedFilter(db, locals.user.id, id, { dryRun: true });
			return json(preview);
		}

		const result = await applySavedFilter(db, locals.user.id, id, {
			resolveProvider: () => loadProvider(platform)
		});
		return json(result);
	} catch (error) {
		return failure(error);
	}
};

function loadProvider(platform: App.Platform | undefined): EmailProvider | undefined {
	try {
		return getEmailProvider(platform);
	} catch (error) {
		if (error instanceof ConfigError) return undefined;
		throw error;
	}
}

/** An empty body runs the filter. Invalid JSON is refused. `{ dryRun: true }` only previews. */
async function readBody(request: Request): Promise<Record<string, unknown> | null | 'invalid'> {
	const text = await request.text();
	if (!text.trim()) return null;

	try {
		const body = JSON.parse(text) as unknown;
		if (!body || typeof body !== 'object' || Array.isArray(body)) return 'invalid';
		return body as Record<string, unknown>;
	} catch {
		return 'invalid';
	}
}

function failure(error: unknown): Response {
	if (error instanceof FilterWriteError) return json({ error: error.code }, { status: 400 });
	if (error instanceof FilterNotFoundError) return json({ error: 'Not found' }, { status: 404 });
	throw error;
}
