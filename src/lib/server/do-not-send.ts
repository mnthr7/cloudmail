/**
 * Marketing mail: the do-not-send list and unsubscribe links.
 *
 * A message sent with `marketing: true` carries RFC 8058 one-click
 * List-Unsubscribe headers and a visible unsubscribe footer, and goes to one
 * recipient at a time so each link is that person's own.
 *
 * Who is blocked:
 * - bounced (scope '*'): the address doesn't exist. Blocks every send, from
 *   every domain. Fed by Resend's hard-bounce events.
 * - complained (scope = sending domain): they marked our mail as spam. Blocks
 *   marketing from that domain. Fed by Resend's complaint events.
 * - unsubscribed (scope = sending domain): they clicked unsubscribe. Blocks
 *   marketing from that domain.
 * - manual (either scope): an admin added it. Blocks every send in its scope.
 *
 * Ordinary one-to-one mail is only stopped by bounced and manual rows, so a
 * person who unsubscribed from a newsletter still gets your reply.
 */
import type { D1Database } from '@cloudflare/workers-types';
import { parseEmailAddress } from '#lib/email-address.ts';
import { escapeHtml } from './send-mail';

export type DoNotSendReason = 'unsubscribed' | 'bounced' | 'complained' | 'manual';

/** Every domain. Used for hard bounces: the address itself is dead. */
export const ALL_DOMAINS = '*';

export type DoNotSendEntry = {
	id: string;
	address: string;
	scope: string;
	reason: DoNotSendReason;
	detail: string | null;
	created_at: string;
};

export type BlockedRecipient = { address: string; reason: DoNotSendReason; scope: string };

const REASONS: DoNotSendReason[] = ['unsubscribed', 'bounced', 'complained', 'manual'];

export function isDoNotSendReason(value: unknown): value is DoNotSendReason {
	return typeof value === 'string' && (REASONS as string[]).includes(value);
}

export function normalizeAddress(value: string): string {
	return parseEmailAddress(value);
}

export function domainOf(address: string): string {
	return normalizeAddress(address).split('@')[1] ?? '';
}

/* -------------------------------------------------------------------------- */
/* The list                                                                    */
/* -------------------------------------------------------------------------- */

export async function listDoNotSend(db: D1Database, limit = 500): Promise<DoNotSendEntry[]> {
	const { results } = await db
		.prepare('SELECT * FROM do_not_send ORDER BY datetime(created_at) DESC, id DESC LIMIT ?')
		.bind(limit)
		.all<DoNotSendEntry>();
	return results;
}

/**
 * Adds or updates one row. An unsubscribe never downgrades a stronger reason
 * already there (a complaint stays a complaint).
 */
export async function addDoNotSend(
	db: D1Database,
	input: { address: string; scope: string; reason: DoNotSendReason; detail?: string | null }
): Promise<void> {
	const address = normalizeAddress(input.address);
	if (!address.includes('@')) throw new Error('Not an email address');
	const scope = input.scope === ALL_DOMAINS ? ALL_DOMAINS : input.scope.trim().toLowerCase();
	if (!scope) throw new Error('Scope is required');

	await db
		.prepare(
			`INSERT INTO do_not_send (id, address, scope, reason, detail)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT (address, scope) DO UPDATE SET
				reason = CASE WHEN excluded.reason = 'unsubscribed' THEN do_not_send.reason ELSE excluded.reason END,
				detail = COALESCE(excluded.detail, do_not_send.detail)`
		)
		.bind(crypto.randomUUID(), address, scope, input.reason, input.detail?.slice(0, 500) ?? null)
		.run();
}

export async function removeDoNotSend(db: D1Database, id: string): Promise<boolean> {
	const result = await db.prepare('DELETE FROM do_not_send WHERE id = ?').bind(id).run();
	return (result.meta.changes ?? 0) > 0;
}

/**
 * The recipients this send must not go to. Marketing is stopped by any row in
 * scope; ordinary mail only by bounced and manual rows.
 */
export async function blockedRecipients(
	db: D1Database,
	recipients: string[],
	fromDomain: string,
	marketing: boolean
): Promise<BlockedRecipient[]> {
	const addresses = [...new Set(recipients.map(normalizeAddress).filter((a) => a.includes('@')))];
	if (addresses.length === 0) return [];

	const placeholders = addresses.map(() => '?').join(', ');
	const { results } = await db
		.prepare(
			`SELECT address, scope, reason FROM do_not_send
			  WHERE address IN (${placeholders}) AND scope IN (?, ?)`
		)
		.bind(...addresses, ALL_DOMAINS, fromDomain.toLowerCase())
		.all<BlockedRecipient>();

	return results.filter((row) => marketing || row.reason === 'bounced' || row.reason === 'manual');
}

const REASON_TEXT: Record<DoNotSendReason, string> = {
	bounced: 'hard-bounced before (the address does not exist)',
	complained: 'marked your mail as spam',
	unsubscribed: 'unsubscribed',
	manual: 'is on the do-not-send list'
};

export class DoNotSendError extends Error {
	constructor(readonly blocked: BlockedRecipient[]) {
		super(
			`Not sent: ${blocked.map((row) => `${row.address} ${REASON_TEXT[row.reason]}`).join('; ')}. ` +
				'An admin can remove an address from the do-not-send list in Admin.'
		);
		this.name = 'DoNotSendError';
	}
}

/** Throws DoNotSendError when any recipient is blocked. */
export async function assertSendable(
	db: D1Database,
	recipients: string[],
	fromAddress: string,
	marketing: boolean
): Promise<void> {
	const blocked = await blockedRecipients(db, recipients, domainOf(fromAddress), marketing);
	if (blocked.length > 0) throw new DoNotSendError(blocked);
}

/* -------------------------------------------------------------------------- */
/* Unsubscribe links                                                           */
/* -------------------------------------------------------------------------- */

function randomToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(24));
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** The recipient's token for this sending domain, created on first use. */
export async function unsubscribeToken(db: D1Database, scope: string, address: string): Promise<string> {
	const normalizedScope = scope.toLowerCase();
	const normalized = normalizeAddress(address);
	await db
		.prepare(
			`INSERT INTO unsubscribe_links (token, scope, address) VALUES (?, ?, ?)
			 ON CONFLICT (scope, address) DO NOTHING`
		)
		.bind(randomToken(), normalizedScope, normalized)
		.run();
	const row = await db
		.prepare('SELECT token FROM unsubscribe_links WHERE scope = ? AND address = ?')
		.bind(normalizedScope, normalized)
		.first<{ token: string }>();
	if (!row) throw new Error('Could not create an unsubscribe link');
	return row.token;
}

export type Subscription = { scope: string; address: string; subscribed: boolean };

export async function readSubscription(db: D1Database, token: string): Promise<Subscription | null> {
	if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
	const link = await db
		.prepare('SELECT scope, address FROM unsubscribe_links WHERE token = ?')
		.bind(token)
		.first<{ scope: string; address: string }>();
	if (!link) return null;
	const blocked = await blockedRecipients(db, [link.address], link.scope, true);
	return { ...link, subscribed: blocked.length === 0 };
}

/** One-click or page unsubscribe. Idempotent. */
export async function unsubscribeByToken(db: D1Database, token: string): Promise<Subscription | null> {
	const current = await readSubscription(db, token);
	if (!current) return null;
	await addDoNotSend(db, { address: current.address, scope: current.scope, reason: 'unsubscribed' });
	return { ...current, subscribed: false };
}

/**
 * The person asked to get the mail again. Clears their unsubscribe and any
 * complaint for this domain. A hard bounce or an admin's block stays.
 */
export async function resubscribeByToken(db: D1Database, token: string): Promise<Subscription | null> {
	const current = await readSubscription(db, token);
	if (!current) return null;
	await db
		.prepare(
			`DELETE FROM do_not_send
			  WHERE address = ? AND scope = ? AND reason IN ('unsubscribed', 'complained')`
		)
		.bind(current.address, current.scope)
		.run();
	return readSubscription(db, token);
}

/* -------------------------------------------------------------------------- */
/* What a marketing message carries                                            */
/* -------------------------------------------------------------------------- */

export function unsubscribePageUrl(origin: string, token: string): string {
	return `${origin.replace(/\/+$/, '')}/unsubscribe/${token}`;
}

export function oneClickUrl(origin: string, token: string): string {
	return `${origin.replace(/\/+$/, '')}/api/unsubscribe/${token}`;
}

/**
 * Headers and footer for one marketing message. Gmail and Yahoo require both
 * headers (RFC 8058) for bulk senders; the footer is the visible link they
 * also require.
 */
export function marketingParts(origin: string, token: string, domain: string, text: string, html: string | undefined) {
	const page = unsubscribePageUrl(origin, token);
	const headers = {
		'List-Unsubscribe': `<${oneClickUrl(origin, token)}>`,
		'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
	};
	// Worded to be true for a newsletter and for a first email to a business alike:
	// it claims no sign-up the recipient may never have made.
	const textFooter = `\n\n--\nDon't want emails like this from ${domain}? Unsubscribe: ${page}`;
	const htmlFooter =
		`<p style="margin:32px 0 0;padding-top:12px;border-top:1px solid #e5e5e5;font-size:12px;line-height:1.5;color:#6b6b6b;">` +
		`Don't want emails like this from ${escapeHtml(domain)}? ` +
		`<a href="${escapeHtml(page)}" style="color:#6b6b6b;text-decoration:underline;">Unsubscribe</a></p>`;
	return {
		headers,
		text: `${text}${textFooter}`,
		html: `${html?.trim() || escapeHtml(text).replaceAll('\n', '<br>\n')}\n${htmlFooter}`
	};
}

/* -------------------------------------------------------------------------- */
/* One-click endpoint                                                          */
/* -------------------------------------------------------------------------- */

const ONE_CLICK_PATH = /^\/api\/unsubscribe\/([A-Za-z0-9_-]{16,64})\/?$/;

/**
 * RFC 8058 one-click unsubscribe, answered by the Worker before SvelteKit:
 * Gmail and Yahoo POST a form body with no Origin header, which SvelteKit's
 * cross-site form check would refuse. No confirmation step: the spec says the
 * POST itself is the request. A GET (someone opening the header URL) goes to
 * the page instead. Null when the request isn't for this path.
 */
export async function handleOneClickUnsubscribe(request: Request, db: D1Database): Promise<Response | null> {
	const url = new URL(request.url);
	const match = ONE_CLICK_PATH.exec(url.pathname);
	if (!match) return null;
	const token = match[1]!;

	if (request.method === 'GET' || request.method === 'HEAD') {
		return new Response(null, { status: 303, headers: { Location: `/unsubscribe/${token}` } });
	}
	if (request.method !== 'POST') {
		return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } });
	}
	const result = await unsubscribeByToken(db, token);
	if (!result) return new Response('Not found', { status: 404 });
	return new Response('Unsubscribed', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
