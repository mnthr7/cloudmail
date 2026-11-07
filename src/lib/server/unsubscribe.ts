import type { D1Database } from '@cloudflare/workers-types';
import { parseEmailAddresses } from '#lib/email-address.ts';
import { parseUnsubscribe, publicHttpsError } from '#lib/organizing/unsubscribe.ts';
import type { MailAddress, User } from '#lib/types.ts';
import { getAddressByValueForUser, getDefaultAddress } from './domains';
import type { EmailProvider } from './email-provider';
import { sendOutboundEmail } from './send-mail';

/** One-click may follow this many redirects, then it stops. */
const MAX_REDIRECTS = 3;

export type UnsubscribeErrorCode =
	| 'https'
	| 'private'
	| 'invalid'
	| 'redirect'
	| 'network'
	| 'status'
	| 'send'
	| 'address'
	| 'header';

/** A refused or failed unsubscribe. Routes map `code` to HTTP 400 `{ error: code }`. */
export class UnsubscribeError extends Error {
	readonly status = 400;

	constructor(readonly code: UnsubscribeErrorCode) {
		super(code);
		this.name = 'UnsubscribeError';
	}
}

/** No message for this user. Routes map this to HTTP 404. */
export class UnsubscribeNotFoundError extends Error {
	readonly status = 404;

	constructor() {
		super('Not found');
		this.name = 'UnsubscribeNotFoundError';
	}
}

export type UnsubscribeOptions = {
	fetch?: typeof fetch;
	/** Used by tests. The route passes `resolveProvider` so one-click never loads mail config. */
	provider?: EmailProvider;
	resolveProvider?: () => EmailProvider | undefined;
};

type UnsubscribeRow = {
	to_addr: string;
	list_unsubscribe: string | null;
	list_unsubscribe_post: string | null;
};

/**
 * Unsubscribe one message and leave the row as it is.
 * One-click wins when `list_unsubscribe_post` contains `one-click` and the header has an HTTPS URL.
 * A refused one-click URL does not fall through to mailto.
 * Otherwise a mailto address gets one plain message. The subject is the mailto
 * `subject` parameter, or `Unsubscribe`.
 */
export async function unsubscribeMessage(
	db: D1Database,
	user: Pick<User, 'id' | 'name'>,
	emailId: string,
	options: UnsubscribeOptions = {}
): Promise<void> {
	const row = await db
		.prepare(
			`SELECT to_addr, list_unsubscribe, list_unsubscribe_post
			 FROM emails WHERE id = ? AND user_id = ?`
		)
		.bind(emailId, user.id)
		.first<UnsubscribeRow>();

	if (!row) throw new UnsubscribeNotFoundError();

	const parsed = parseUnsubscribe(row.list_unsubscribe);
	if (wantsOneClick(row.list_unsubscribe_post) && parsed.https) {
		await postListUnsubscribe(parsed.https, options.fetch ?? globalThis.fetch);
		return;
	}

	if (parsed.mailto) {
		await sendUnsubscribeMail(db, user, row.to_addr, parsed.mailto, parsed.subject, options);
		return;
	}

	throw new UnsubscribeError('header');
}

/**
 * POST `List-Unsubscribe=One-Click` to a public HTTPS URL.
 * Each hop has its own 10 second timeout. Redirects are not followed by `fetch`
 * (`redirect: 'manual'`): `Location` is resolved against the current URL and
 * checked with `publicHttpsError` again. The fourth redirect is not fetched.
 */
export async function postListUnsubscribe(
	start: string,
	fetchImpl: typeof fetch = globalThis.fetch
): Promise<void> {
	const refused = publicHttpsError(start);
	if (refused) throw new UnsubscribeError(refused);

	let current = start;
	for (let followed = 0; followed <= MAX_REDIRECTS; followed++) {
		let response: Response;
		try {
			response = await fetchImpl(current, oneClickRequest());
		} catch {
			throw new UnsubscribeError('network');
		}

		if (response.type === 'opaqueredirect' || isRedirect(response.status)) {
			const next = resolveRedirect(current, response.headers.get('location'));
			if (!next) throw new UnsubscribeError('redirect');
			const nextRefused = publicHttpsError(next);
			if (nextRefused) throw new UnsubscribeError(nextRefused);
			if (followed === MAX_REDIRECTS) throw new UnsubscribeError('redirect');
			current = next;
			continue;
		}

		if (response.status < 200 || response.status >= 300) {
			throw new UnsubscribeError('status');
		}
		return;
	}

	throw new UnsubscribeError('redirect');
}

function wantsOneClick(header: string | null): boolean {
	return !!header && header.toLowerCase().includes('one-click');
}

function oneClickRequest(): RequestInit {
	return {
		method: 'POST',
		redirect: 'manual',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: 'List-Unsubscribe=One-Click',
		signal: AbortSignal.timeout(10_000)
	};
}

function isRedirect(status: number): boolean {
	return status >= 300 && status < 400;
}

function resolveRedirect(current: string, location: string | null): string | null {
	const trimmed = location?.trim();
	if (!trimmed) return null;
	try {
		return new URL(trimmed, current).href;
	} catch {
		return null;
	}
}

/**
 * One plain message through send-mail. From is `to_addr` when that mailbox
 * belongs to the user, otherwise the user's default address. The subject is
 * the mailto subject, or `Unsubscribe`.
 */
async function sendUnsubscribeMail(
	db: D1Database,
	user: Pick<User, 'id' | 'name'>,
	toAddr: string,
	mailto: string,
	subject: string | null,
	options: UnsubscribeOptions
): Promise<void> {
	const provider = options.provider ?? options.resolveProvider?.();
	if (!provider) throw new UnsubscribeError('send');

	const from = await fromAddress(db, user.id, toAddr);
	try {
		await sendOutboundEmail(provider, {
			from,
			senderName: user.name?.trim() || from.address,
			to: mailto,
			subject: subject?.trim() || 'Unsubscribe',
			text: 'Unsubscribe'
		});
	} catch {
		throw new UnsubscribeError('send');
	}
}

async function fromAddress(db: D1Database, userId: string, toAddr: string): Promise<MailAddress> {
	for (const address of parseEmailAddresses(toAddr)) {
		const owned = await getAddressByValueForUser(db, userId, address);
		if (owned) return owned;
	}

	const fallback = await getDefaultAddress(db, userId);
	if (!fallback) throw new UnsubscribeError('address');
	return fallback;
}
