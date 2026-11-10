import type { D1Database } from '@cloudflare/workers-types';
import {
	assessMessage,
	parseAuthResults,
	type MessageSecurity
} from '#lib/security/phishing.ts';
import { parseEmailAddresses } from '#lib/email-address.ts';
import { stripHtml } from './html.ts';

/**
 * Runs the phishing checks on a message that just arrived and stores the
 * result on it. Gathers what the rules need: our own domains, the team's
 * names, the domains this user writes to, and whether the sender is new.
 */

/** How far back "domains you write to" looks. */
const CONTACT_SAMPLE = 1000;

export async function checkInbound(
	db: D1Database,
	userId: string,
	emailId: string,
	headers: { authenticationResults?: string | null; receivedSpf?: string | null }
): Promise<MessageSecurity | null> {
	const row = await db
		.prepare(
			`SELECT from_addr, from_name, reply_to_header, subject, body_text, body_html
			 FROM emails WHERE id = ? AND user_id = ? AND direction = 'inbound'`
		)
		.bind(emailId, userId)
		.first<{
			from_addr: string;
			from_name: string | null;
			reply_to_header: string | null;
			subject: string | null;
			body_text: string | null;
			body_html: string | null;
		}>();
	if (!row) return null;
	const from = row.from_addr.trim().toLowerCase();

	const [domains, teammates, contacts, seen] = await Promise.all([
		db.prepare(`SELECT name FROM domains`).all<{ name: string }>(),
		db.prepare(`SELECT name FROM users`).all<{ name: string | null }>(),
		db
			.prepare(
				`SELECT to_addr, cc_addr FROM emails
				 WHERE user_id = ? AND direction = 'outbound' AND (status IS NULL OR status <> 'draft')
				 ORDER BY created_at DESC LIMIT ?`
			)
			.bind(userId, CONTACT_SAMPLE)
			.all<{ to_addr: string; cc_addr: string | null }>(),
		hasHistoryWith(db, userId, emailId, from)
	]);

	const contactDomains = new Set<string>();
	for (const sent of contacts.results) {
		for (const address of parseEmailAddresses([sent.to_addr, sent.cc_addr ?? ''])) {
			const domain = address.split('@')[1]?.toLowerCase();
			if (domain) contactDomains.add(domain);
		}
	}

	const security = assessMessage({
		fromAddress: from,
		fromName: row.from_name,
		replyTo: row.reply_to_header,
		subject: row.subject ?? '',
		text: row.body_text?.trim() || (row.body_html ? stripHtml(row.body_html) : ''),
		auth: parseAuthResults(
			headers.authenticationResults ? [headers.authenticationResults] : [],
			headers.receivedSpf ? [headers.receivedSpf] : []
		),
		ownDomains: domains.results.map((domain) => domain.name),
		teammateNames: teammates.results.map((user) => user.name ?? '').filter(Boolean),
		contactDomains: [...contactDomains],
		firstTimeSender: !seen
	});

	await db
		.prepare(`UPDATE emails SET security_json = ? WHERE id = ? AND user_id = ?`)
		.bind(JSON.stringify(security), emailId, userId)
		.run();
	return security;
}

/** `%`, `_` and `\` match anything in LIKE; a sender could pick an address full of them. */
function likeLiteral(value: string): string {
	return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Whether this mailbox has heard from, or written to, exactly this address
 * before. LIKE only narrows the candidates; each is then parsed and compared
 * whole, so `ann@x.com` doesn't count as having written to `joann@x.com`.
 */
async function hasHistoryWith(db: D1Database, userId: string, emailId: string, address: string): Promise<boolean> {
	const heard = await db
		.prepare(
			`SELECT 1 AS yes FROM emails
			 WHERE user_id = ? AND id <> ? AND direction = 'inbound' AND lower(from_addr) = ? LIMIT 1`
		)
		.bind(userId, emailId, address)
		.first<{ yes: number }>();
	if (heard) return true;
	const pattern = `%${likeLiteral(address)}%`;
	const { results } = await db
		.prepare(
			`SELECT to_addr, cc_addr FROM emails
			 WHERE user_id = ? AND direction = 'outbound' AND (status IS NULL OR status <> 'draft')
			   AND (lower(to_addr) LIKE ? ESCAPE '\\' OR lower(cc_addr) LIKE ? ESCAPE '\\')
			 LIMIT 50`
		)
		.bind(userId, pattern, pattern)
		.all<{ to_addr: string; cc_addr: string | null }>();
	return results.some((row) =>
		parseEmailAddresses([row.to_addr, row.cc_addr ?? '']).some((sent) => sent.toLowerCase() === address)
	);
}

/** Whether this user sends mail that looks like phishing straight to Spam. */
export async function readPhishingToSpam(db: D1Database, userId: string): Promise<boolean> {
	try {
		const row = await db
			.prepare(`SELECT phishing_to_spam FROM user_preferences WHERE user_id = ?`)
			.bind(userId)
			.first<{ phishing_to_spam: number | null }>();
		return row?.phishing_to_spam === 1;
	} catch {
		return false;
	}
}

export async function setPhishingToSpam(db: D1Database, userId: string, on: boolean): Promise<void> {
	await db
		.prepare(
			`INSERT INTO user_preferences (user_id, phishing_to_spam, updated_at) VALUES (?, ?, datetime('now'))
			 ON CONFLICT(user_id) DO UPDATE SET phishing_to_spam = excluded.phishing_to_spam, updated_at = excluded.updated_at`
		)
		.bind(userId, on ? 1 : 0)
		.run();
}
