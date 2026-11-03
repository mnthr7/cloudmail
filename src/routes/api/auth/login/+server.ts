import { json, type RequestHandler } from '@sveltejs/kit';
import { login, logout, readSessionToken, sessionCookieOptions, SESSION_COOKIE } from '$lib/server/auth';
import { SESSION_DAYS } from '$lib/server/constants';
import { loginKeys, releaseLoginAttempt, reserveLoginAttempt } from '$lib/server/login-limit';

export const POST: RequestHandler = async ({ request, cookies, platform, getClientAddress }) => {
	const db = platform?.env.DB;
	if (!db) return json({ error: 'Database unavailable' }, { status: 503 });

	const body = (await request.json()) as { email?: string; password?: string };
	if (!body.email || !body.password) {
		return json({ error: 'Email and password are required' }, { status: 400 });
	}

	const now = new Date();
	const keys = loginKeys(clientAddress(getClientAddress), body.email);
	const wait = await reserveLoginAttempt(db, keys, now);
	if (wait !== null) {
		return json(
			{ error: 'Too many sign-in attempts. Try again in a few minutes.' },
			{ status: 429, headers: { 'Retry-After': String(wait) } }
		);
	}

	const result = await login(db, body.email, body.password);
	if (!result) {
		return json({ error: 'Invalid email or password' }, { status: 401 });
	}
	await releaseLoginAttempt(db, keys);

	cookies.set(SESSION_COOKIE, result.token, sessionCookieOptions(SESSION_DAYS * 24 * 60 * 60));

	return json({ user: result.user });
};

export const DELETE: RequestHandler = async ({ cookies, platform }) => {
	const db = platform?.env.DB;
	const token = readSessionToken(cookies);

	if (db && token) {
		await logout(db, token);
	}

	cookies.delete(SESSION_COOKIE, { path: '/' });
	return json({ ok: true });
};

function clientAddress(getClientAddress: () => string): string | null {
	try {
		return getClientAddress();
	} catch {
		return null;
	}
}
