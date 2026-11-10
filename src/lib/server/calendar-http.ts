import { json } from '@sveltejs/kit';
import type { D1Database } from '@cloudflare/workers-types';
import { DEMO_MODE, DEMO_USER } from './demo.ts';
import { CalendarError } from './calendar-store.ts';

/** Shared plumbing for /api/calendar routes. */
export function calendarCaller(
	locals: App.Locals,
	platform: App.Platform | undefined,
	{ write }: { write: boolean }
): { db: D1Database; userId: string } | { response: Response } {
	if (!locals.user) return { response: json({ error: 'Unauthorized' }, { status: 401 }) };
	if (DEMO_MODE && locals.user.id === DEMO_USER.id && write) {
		return { response: json({ error: 'Demo mode is read-only' }, { status: 403 }) };
	}
	const db = platform?.env.DB;
	if (!db) return { response: json({ error: 'Unauthorized' }, { status: 401 }) };
	return { db, userId: locals.user.id };
}

export function calendarFailure(error: unknown): Response {
	if (error instanceof CalendarError) return json({ error: error.code }, { status: error.status });
	throw error;
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
	const body = (await request.json().catch(() => null)) as unknown;
	return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}
