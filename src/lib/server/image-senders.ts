import type { D1Database } from '@cloudflare/workers-types';

const CREATE_TRUSTED_IMAGE_SENDERS = `
CREATE TABLE IF NOT EXISTS trusted_image_senders (
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	address TEXT NOT NULL COLLATE NOCASE,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	PRIMARY KEY (user_id, address)
)`;

/** Bare From address, trimmed and lowercased. Blank or missing `@` is rejected. */
function storedAddress(address: string): string | null {
	const trimmed = address.trim();
	if (!trimmed.includes('@')) return null;
	return trimmed.toLowerCase();
}

/**
 * Saves a sender whose remote images may load. Returns false when the address
 * has no `@` after trim. A repeat save is ignored.
 */
export async function rememberImageSender(
	db: D1Database,
	userId: string,
	address: string
): Promise<boolean> {
	const stored = storedAddress(address);
	if (!stored) return false;

	const insert = () =>
		db
			.prepare(
				`INSERT OR IGNORE INTO trusted_image_senders (user_id, address) VALUES (?, ?)`
			)
			.bind(userId, stored)
			.run();

	try {
		await insert();
	} catch {
		await db.prepare(CREATE_TRUSTED_IMAGE_SENDERS).run();
		await insert();
	}
	return true;
}

/** Removes one saved sender. The address is the stored, lowercased form. */
export async function forgetImageSender(
	db: D1Database,
	userId: string,
	address: string
): Promise<void> {
	const stored = storedAddress(address);
	if (!stored) return;
	try {
		await db
			.prepare(`DELETE FROM trusted_image_senders WHERE user_id = ? AND address = ?`)
			.bind(userId, stored)
			.run();
	} catch {
		// A missing table means this account has no saved senders.
	}
}

/** Saved image senders for this account, in address order. */
export async function listImageSenders(db: D1Database, userId: string): Promise<string[]> {
	try {
		const { results } = await db
			.prepare(
				`SELECT address FROM trusted_image_senders WHERE user_id = ? ORDER BY address`
			)
			.bind(userId)
			.all<{ address: string }>();
		return results.map((row) => row.address);
	} catch {
		return [];
	}
}
