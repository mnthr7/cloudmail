import type { D1Database } from '@cloudflare/workers-types';
import { createSessionToken, hashToken } from './crypto';

/** Failed sign-ins allowed per window before that key has to wait. */
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LIMITS = { pair: 10, ip: 20, account: 20, device: 10, knownAccount: 50 } as const;

/** Trusted browsers kept per account; signing in on another retires the oldest. */
const MAX_DEVICES = 10;

/** The cookie that marks a browser as one that has signed in to an account before. */
export const DEVICE_COOKIE = 'cm_device';
export const DEVICE_DAYS = 180;

export type LoginKey = { key: string; limit: number };

/**
 * Which counts an attempt is held to:
 * - IP (20): one client, or one IPv6 /64, trying many accounts;
 * - unknown device: account + IP (10) and the whole account across all IPs (20),
 *   which caps guessing however many machines join in;
 * - known device (`deviceHash`): its own count (10) and a looser count shared by
 *   all of the account's known devices (50). It skips the tight account count,
 *   so a flood of wrong passwords from unknown devices can't lock the owner out.
 */
export function loginKeys(
	rawIp: string | null,
	email: string,
	deviceHash: string | null = null
): LoginKey[] {
	const ip = rawIp ? clientNetwork(rawIp) : null;
	const account = email.trim().toLowerCase();
	const keys: LoginKey[] = deviceHash
		? [
				{ key: `device:${deviceHash}`, limit: LIMITS.device },
				{ key: `known:${account}`, limit: LIMITS.knownAccount }
			]
		: [
				{ key: `account:${account}`, limit: LIMITS.account },
				{ key: `pair:${ip ?? 'unknown'}|${account}`, limit: LIMITS.pair }
			];
	if (ip) keys.push({ key: `ip:${ip}`, limit: LIMITS.ip });
	return keys;
}

/** A fingerprint of the account's current password hash, or null for no such account. */
async function credentialOf(db: D1Database, account: string): Promise<string | null> {
	const row = await db
		.prepare('SELECT password_hash FROM users WHERE email = ?')
		.bind(account)
		.first<{ password_hash: string }>();
	return row ? hashToken(row.password_hash) : null;
}

/**
 * The device's hash when its cookie belongs to this account and was issued
 * under the account's current password, else null.
 */
export async function knownDevice(
	db: D1Database,
	token: string | undefined,
	email: string,
	now: Date
): Promise<string | null> {
	if (!token) return null;
	const account = email.trim().toLowerCase();
	const hash = await hashToken(token);
	const since = new Date(now.getTime() - DEVICE_DAYS * 24 * 60 * 60 * 1000).toISOString();
	const row = await db
		.prepare(
			'SELECT credential FROM login_devices WHERE token_hash = ? AND account = ? AND created_at > ?'
		)
		.bind(hash, account, since)
		.first<{ credential: string }>();
	if (!row) return null;
	return row.credential === (await credentialOf(db, account)) ? hash : null;
}

/**
 * Remember this browser for the account, under its current password. Keeps
 * the newest few devices per account. Returns the cookie token to set.
 */
export async function rememberDevice(db: D1Database, email: string, now: Date): Promise<string> {
	const token = createSessionToken();
	const account = email.trim().toLowerCase();
	const credential = await credentialOf(db, account);
	if (!credential) throw new Error('No such account');
	await db
		.prepare(
			'INSERT INTO login_devices (token_hash, account, credential, created_at) VALUES (?, ?, ?, ?)'
		)
		.bind(await hashToken(token), account, credential, now.toISOString())
		.run();
	await db
		.prepare(
			`DELETE FROM login_devices WHERE account = ? AND (credential != ? OR token_hash NOT IN (
				SELECT token_hash FROM login_devices WHERE account = ? ORDER BY created_at DESC LIMIT ?
			))`
		)
		.bind(account, credential, account, MAX_DEVICES)
		.run();
	await db
		.prepare('DELETE FROM login_devices WHERE created_at < ?')
		.bind(new Date(now.getTime() - DEVICE_DAYS * 24 * 60 * 60 * 1000).toISOString())
		.run();
	return token;
}

/**
 * The unit an attacker can cheaply rotate through. IPv4 stays a single address;
 * IPv6 is grouped by its /64, since one host is usually handed a whole /64.
 */
export function clientNetwork(ip: string): string {
	const address = ip.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] ?? '';
	if (!address.includes(':')) return address;
	const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	if (mapped) return mapped[1];

	const [head, tail = ''] = address.split('::');
	const left = head ? head.split(':') : [];
	const right = address.includes('::') && tail ? tail.split(':') : [];
	const groups = address.includes('::')
		? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
		: left;
	const prefix = groups
		.slice(0, 4)
		.map((group) => (group || '0').replace(/^0+(?=.)/, ''))
		.join(':');
	return `${prefix}::/64`;
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
 * A correct password gives the attempt back: this client's or device's count
 * is cleared, and the reserved attempt is refunded on the shared keys.
 */
export async function releaseLoginAttempt(db: D1Database, keys: LoginKey[]): Promise<void> {
	for (const { key } of keys) {
		if (key.startsWith('pair:') || key.startsWith('device:')) {
			await db.prepare('DELETE FROM login_failures WHERE key = ?').bind(key).run();
		} else {
			await db
				.prepare('UPDATE login_failures SET count = MAX(count - 1, 0) WHERE key = ?')
				.bind(key)
				.run();
		}
	}
}
