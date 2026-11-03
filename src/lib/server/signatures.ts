import type { D1Database } from '@cloudflare/workers-types';

/** Stores signature HTML for an address owned by this user. Blank HTML clears it. */
export async function saveSignature(
	db: D1Database,
	userId: string,
	addressId: string,
	html: string
): Promise<boolean> {
	const value = html.trim() ? html : null;
	const result = await db
		.prepare('UPDATE addresses SET signature_html = ? WHERE id = ? AND user_id = ?')
		.bind(value, addressId, userId)
		.run();
	return result.meta.changes === 1;
}
