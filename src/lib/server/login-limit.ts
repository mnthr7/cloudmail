import type { D1Database } from '@cloudflare/workers-types';

/** Failed sign-ins allowed per window before that key has to wait. */
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LIMITS = { pair: 10, ip: 20, account: 100 } as const;

export type LoginKey = { key: string; limit: number };

/**
 * Three keys, so a stranger can't cheaply lock out a real user:
 * - account + IP (10): the brute-force brake, and it only blocks that client;
 * - IP (20): one client trying many accounts;
 * - account (100): a loose ceiling on guesses spread across many IPs.
 */
export function loginKeys(ip: string | null, email: string): LoginKey[] {
	const account = email.trim().toLowerCase();
	const keys: LoginKey[] = [{ key: `account:${account}`, limit: LIMITS.account }];
	keys.push({ key: `pair:${ip ?? 'unknown'}|${account}`, limit: LIMITS.pair });
	if (ip) keys.push({ key: `ip:${ip}`, limit: LIMITS.ip });
	return keys;
}

/**
 * Count this attempt against every key before the password is checked, in one
 * statement per key, so parallel guesses can't all slip in under the limit.
 * Returns the seconds to wait when any key is over its limit, or null to go ahead.
 */
export async function reserveLoginAttempt(
	db: D1Database,
	keys: LoginKey[],
	now: Date
): Promise<number | null> {
	const at = now.toISOString();
	const since = new Date(now.getTime() - LOGIN_WINDOW_MS).toISOString();
	let wait: number | null = null;
	for (const { key, limit } of keys) {
		const row = await db
			.prepare(
				`INSERT INTO login_failures (key, count, window_start) VALUES (?, 1, ?)
				 ON CONFLICT(key) DO UPDATE SET
					count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
					window_start = CASE WHEN window_start <= ? THEN excluded.window_start ELSE window_start END
				 RETURNING count, window_start`
			)
			.bind(key, at, since, since)
			.first<{ count: number; window_start: string }>();
		if (!row || row.count <= limit) continue;
		const seconds = Math.ceil((Date.parse(row.window_start) + LOGIN_WINDOW_MS - now.getTime()) / 1000);
		wait = Math.max(wait ?? 0, seconds, 1);
	}
	// Keep the table small: anything a day old can no longer block.
	await db
		.prepare('DELETE FROM login_failures WHERE window_start < ?')
		.bind(new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString())
		.run();
	return wait;
}

/**
 * A correct password gives the attempt back: this client's count for the
 * account is cleared, and the reserved attempt is refunded on the shared keys.
 */
export async function releaseLoginAttempt(db: D1Database, keys: LoginKey[]): Promise<void> {
	for (const { key } of keys) {
		if (key.startsWith('pair:')) {
			await db.prepare('DELETE FROM login_failures WHERE key = ?').bind(key).run();
		} else {
			await db
				.prepare('UPDATE login_failures SET count = MAX(count - 1, 0) WHERE key = ?')
				.bind(key)
				.run();
		}
	}
}
