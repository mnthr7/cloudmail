import type { D1Database } from '@cloudflare/workers-types';
import { SESSION_COOKIE, SESSION_DAYS } from './constants';
import { createSessionToken, hashPassword, hashToken, verifyPassword } from './crypto';
import type { User } from '$lib/types';
import { parseThreshold } from '../security/verdict';
import { parseUndoSeconds, type UndoSeconds } from '../writing/timing';

type UserRow = {
	id: string;
	email: string;
	name: string;
	is_admin: number;
	created_at: string;
	mail_skin?: string | null;
};

function mapUser(row: UserRow): User {
	return {
		id: row.id,
		email: row.email,
		name: row.name,
		is_admin: row.is_admin === 1,
		created_at: row.created_at,
		mail_skin: row.mail_skin ?? null
	};
}

export async function countUsers(db: D1Database): Promise<number> {
	const row = await db.prepare('SELECT COUNT(*) AS count FROM users').first<{ count: number }>();
	return row?.count ?? 0;
}

export async function getUserByEmail(db: D1Database, email: string): Promise<(User & { password_hash: string }) | null> {
	const row = await db
		.prepare('SELECT id, email, name, password_hash, is_admin, created_at FROM users WHERE email = ?')
		.bind(email.toLowerCase())
		.first<UserRow & { password_hash: string }>();

	return row ? { ...mapUser(row), password_hash: row.password_hash } : null;
}

export async function getUserById(db: D1Database, id: string): Promise<User | null> {
	const row = await db
		.prepare('SELECT id, email, name, is_admin, created_at FROM users WHERE id = ?')
		.bind(id)
		.first<UserRow>();

	return row ? mapUser(row) : null;
}

export async function listUsers(db: D1Database): Promise<User[]> {
	const { results } = await db
		.prepare('SELECT id, email, name, is_admin, created_at FROM users ORDER BY created_at ASC')
		.all<UserRow>();

	return results.map(mapUser);
}

export async function createUser(
	db: D1Database,
	input: { email: string; name: string; password: string; isAdmin?: boolean }
): Promise<User> {
	// This is a login identity only. Mail identities live in `addresses` and are
	// bound to connected Resend domains, so an operator can sign in with any
	// address they control while sending as name@their-resend-domain.
	const email = input.email.toLowerCase().trim();
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		throw new Error('Enter a valid email address');
	}

	const existing = await getUserByEmail(db, email);
	if (existing) {
		throw new Error('An account with that email already exists');
	}

	const id = crypto.randomUUID();
	const password_hash = await hashPassword(input.password);

	await db
		.prepare(
			'INSERT INTO users (id, email, name, password_hash, is_admin) VALUES (?, ?, ?, ?, ?)'
		)
		.bind(id, email, input.name.trim(), password_hash, input.isAdmin ? 1 : 0)
		.run();

	const user = await getUserById(db, id);
	if (!user) throw new Error('Failed to create user');
	return user;
}

export async function bootstrapAdmin(
	db: D1Database,
	input: { email: string; name: string; password: string }
): Promise<User> {
	const existing = await countUsers(db);
	if (existing > 0) {
		throw new Error('Setup already completed');
	}

	const email = input.email.toLowerCase().trim();
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		throw new Error('Enter a valid email address');
	}

	// The insert itself checks the table is still empty, so two setups racing
	// past the count above cannot both create an admin.
	const id = crypto.randomUUID();
	const password_hash = await hashPassword(input.password);
	const inserted = await db
		.prepare(
			`INSERT INTO users (id, email, name, password_hash, is_admin)
			 SELECT ?, ?, ?, ?, 1 WHERE NOT EXISTS (SELECT 1 FROM users)`
		)
		.bind(id, email, input.name.trim(), password_hash)
		.run();
	if (!inserted.meta.changes) {
		throw new Error('Setup already completed');
	}

	const user = await getUserById(db, id);
	if (!user) throw new Error('Failed to create user');
	return user;
}

let dummy: Promise<string> | null = null;
function dummyHash(): Promise<string> {
	dummy ??= hashPassword(crypto.randomUUID());
	return dummy;
}

export async function login(
	db: D1Database,
	email: string,
	password: string
): Promise<{ user: User; token: string } | null> {
	const user = await getUserByEmail(db, email);
	if (!user) {
		// Spend the same PBKDF2 time as a real check, so timing doesn't reveal
		// which addresses have accounts.
		await verifyPassword(password, await dummyHash());
		return null;
	}

	const valid = await verifyPassword(password, user.password_hash);
	if (!valid) return null;

	const token = createSessionToken();
	const token_hash = await hashToken(token);
	const sessionId = crypto.randomUUID();
	const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();

	await db
		.prepare('INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)')
		.bind(sessionId, user.id, token_hash, expiresAt)
		.run();

	const { password_hash: _, ...safeUser } = user;
	return { user: safeUser, token };
}

export async function logout(db: D1Database, token: string): Promise<void> {
	const token_hash = await hashToken(token);
	await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(token_hash).run();
}

export async function getUserFromSession(db: D1Database, token: string | undefined): Promise<User | null> {
	if (!token) return null;

	const token_hash = await hashToken(token);
	const query = (columns: string) =>
		db
			.prepare(
				`SELECT ${columns}
				 FROM sessions s
				 JOIN users u ON u.id = s.user_id
				 WHERE s.token_hash = ? AND s.expires_at > datetime('now')`
			)
			.bind(token_hash)
			.first<UserRow>();

	let row: UserRow | null;
	try {
		row = await query(
			'u.id, u.email, u.name, u.is_admin, u.created_at, (SELECT p.mail_skin FROM user_preferences p WHERE p.user_id = u.id) AS mail_skin'
		);
	} catch {
		// user_preferences not created yet (nobody has picked a theme): sign-in must keep working.
		row = await query('u.id, u.email, u.name, u.is_admin, u.created_at');
	}

	return row ? mapUser(row) : null;
}

export function sessionCookieOptions(maxAgeSeconds: number) {
	return {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: 'lax' as const,
		maxAge: maxAgeSeconds
	};
}

export function readSessionToken(cookies: { get: (name: string) => string | undefined }): string | undefined {
	return cookies.get(SESSION_COOKIE);
}

export { SESSION_COOKIE };

/** Saves the account's mail skin (Ledger, Desk, Notes or Classic). */
export async function setUserMailSkin(db: D1Database, userId: string, skin: string): Promise<void> {
	const upsert = () =>
		db
			.prepare(
				`INSERT INTO user_preferences (user_id, mail_skin, updated_at) VALUES (?, ?, datetime('now'))
				 ON CONFLICT(user_id) DO UPDATE SET mail_skin = excluded.mail_skin, updated_at = excluded.updated_at`
			)
			.bind(userId, skin)
			.run();
	try {
		await upsert();
	} catch {
		// Creates the table only when it is missing. An existing table is left
		// alone; migration 0011 adds undo_send_seconds there.
		await db
			.prepare(
				`CREATE TABLE IF NOT EXISTS user_preferences (
					user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
					mail_skin TEXT,
					priority_inbox INTEGER NOT NULL DEFAULT 0,
					undo_send_seconds INTEGER NOT NULL DEFAULT 10,
					vt_malicious_threshold INTEGER NOT NULL DEFAULT 1,
					updated_at TEXT NOT NULL DEFAULT (datetime('now'))
				)`
			)
			.run();
		await upsert();
	}
}

/**
 * Saves Priority Inbox. The conflict update writes `priority_inbox` only,
 * so an existing `mail_skin` stays as it is.
 */
export async function setUserPriorityInbox(
	db: D1Database,
	userId: string,
	on: boolean
): Promise<void> {
	const upsert = () =>
		db
			.prepare(
				`INSERT INTO user_preferences (user_id, priority_inbox, updated_at)
				 VALUES (?, ?, datetime('now'))
				 ON CONFLICT(user_id) DO UPDATE SET
				   priority_inbox = excluded.priority_inbox,
				   updated_at = excluded.updated_at`
			)
			.bind(userId, on ? 1 : 0)
			.run();
	try {
		await upsert();
	} catch {
		await db
			.prepare(
				`CREATE TABLE IF NOT EXISTS user_preferences (
					user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
					mail_skin TEXT,
					priority_inbox INTEGER NOT NULL DEFAULT 0,
					undo_send_seconds INTEGER NOT NULL DEFAULT 10,
					vt_malicious_threshold INTEGER NOT NULL DEFAULT 1,
					updated_at TEXT NOT NULL DEFAULT (datetime('now'))
				)`
			)
			.run();
		await upsert();
	}
}

/**
 * Saves how long Send can still be undone. The conflict update writes
 * `undo_send_seconds` only, so mail skin and Priority Inbox stay as they are.
 */
export async function setUserUndoSendSeconds(
	db: D1Database,
	userId: string,
	seconds: UndoSeconds
): Promise<void> {
	const upsert = () =>
		db
			.prepare(
				`INSERT INTO user_preferences (user_id, undo_send_seconds, updated_at)
				 VALUES (?, ?, datetime('now'))
				 ON CONFLICT(user_id) DO UPDATE SET
				   undo_send_seconds = excluded.undo_send_seconds,
				   updated_at = excluded.updated_at`
			)
			.bind(userId, seconds)
			.run();
	try {
		await upsert();
	} catch {
		await db
			.prepare(
				`CREATE TABLE IF NOT EXISTS user_preferences (
					user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
					mail_skin TEXT,
					priority_inbox INTEGER NOT NULL DEFAULT 0,
					undo_send_seconds INTEGER NOT NULL DEFAULT 10,
					vt_malicious_threshold INTEGER NOT NULL DEFAULT 1,
					updated_at TEXT NOT NULL DEFAULT (datetime('now'))
				)`
			)
			.run();
		await upsert();
	}
}

/**
 * Saves how many engines must say malicious before an attachment is blocked.
 * The conflict update writes `vt_malicious_threshold` only, so the other
 * preference columns stay as they are.
 */
export async function setUserVtThreshold(
	db: D1Database,
	userId: string,
	threshold: number
): Promise<void> {
	const upsert = () =>
		db
			.prepare(
				`INSERT INTO user_preferences (user_id, vt_malicious_threshold, updated_at)
				 VALUES (?, ?, datetime('now'))
				 ON CONFLICT(user_id) DO UPDATE SET
				   vt_malicious_threshold = excluded.vt_malicious_threshold,
				   updated_at = excluded.updated_at`
			)
			.bind(userId, threshold)
			.run();
	try {
		await upsert();
	} catch {
		await db
			.prepare(
				`CREATE TABLE IF NOT EXISTS user_preferences (
					user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
					mail_skin TEXT,
					priority_inbox INTEGER NOT NULL DEFAULT 0,
					undo_send_seconds INTEGER NOT NULL DEFAULT 10,
					vt_malicious_threshold INTEGER NOT NULL DEFAULT 1,
					updated_at TEXT NOT NULL DEFAULT (datetime('now'))
				)`
			)
			.run();
		await upsert();
	}
}

/** Saved scan threshold. Missing row, or a value outside 1–70, reads as 1. */
export async function readVtThreshold(db: D1Database, userId: string): Promise<number> {
	try {
		const row = await db
			.prepare('SELECT vt_malicious_threshold FROM user_preferences WHERE user_id = ?')
			.bind(userId)
			.first<{ vt_malicious_threshold: number | null }>();
		return parseThreshold(row?.vt_malicious_threshold) ?? 1;
	} catch {
		return 1;
	}
}

/** Saved undo window. Missing row, or a value outside 5, 10, 20, and 30, reads as 10. */
export async function readUndoSendSeconds(db: D1Database, userId: string): Promise<UndoSeconds> {
	try {
		const row = await db
			.prepare('SELECT undo_send_seconds FROM user_preferences WHERE user_id = ?')
			.bind(userId)
			.first<{ undo_send_seconds: number | null }>();
		return parseUndoSeconds(row?.undo_send_seconds) ?? 10;
	} catch {
		return 10;
	}
}

/** True when this account has Priority Inbox on. Missing table or column reads as off. */
export async function readPriorityInbox(db: D1Database, userId: string): Promise<boolean> {
	try {
		const row = await db
			.prepare('SELECT priority_inbox FROM user_preferences WHERE user_id = ?')
			.bind(userId)
			.first<{ priority_inbox: number | null }>();
		return Number(row?.priority_inbox) === 1;
	} catch {
		return false;
	}
}
