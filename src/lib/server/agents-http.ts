import { json } from '@sveltejs/kit';
import type { D1Database } from '@cloudflare/workers-types';
import { AgentDefinitionError } from '#lib/agents/definition.ts';
import { DEMO_MODE, DEMO_USER } from './demo';
import { ActionStateError, AgentNotFoundError, NotAllowedError } from './agents-store';

/** Shared plumbing for /api/agents routes: who is asking, the body, and error responses. */

type Caller = { db: D1Database; userId: string } | { response: Response };

export function caller(
	locals: App.Locals,
	platform: App.Platform | undefined,
	{ write }: { write: boolean }
): Caller {
	if (!locals.user) return { response: json({ error: 'Unauthorized' }, { status: 401 }) };
	// Demo mode is server-env only (DEMO_MODE="true"), never a URL param.
	if (DEMO_MODE && locals.user.id === DEMO_USER.id) {
		return {
			response: write
				? json({ error: 'Demo mode is read-only' }, { status: 403 })
				: json({ error: 'Agents are not part of the demo' }, { status: 404 })
		};
	}
	const db = platform?.env.DB;
	if (!db) return { response: json({ error: 'Unauthorized' }, { status: 401 }) };
	return { db, userId: locals.user.id };
}

export async function readBody(request: Request): Promise<Record<string, unknown> | null> {
	const body = (await request.json().catch(() => null)) as unknown;
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
	return body as Record<string, unknown>;
}

export function failure(error: unknown): Response {
	if (error instanceof AgentDefinitionError) return json({ error: error.code }, { status: 400 });
	if (error instanceof AgentNotFoundError) return json({ error: 'Not found' }, { status: 404 });
	if (error instanceof NotAllowedError) return json({ error: 'Not allowed' }, { status: 403 });
	if (error instanceof ActionStateError) {
		if (error.current === 'missing') return json({ error: 'Not found' }, { status: 404 });
		return json({ error: 'state', current: error.current }, { status: 409 });
	}
	throw error;
}
