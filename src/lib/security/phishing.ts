import { mixedScripts, oneEditAway, registrableDomain } from './host';
import { senderWarning } from './sender';

/**
 * Phishing signals for one inbound message. Pure: the caller gathers what we
 * know (authentication results, our own domains, who the user writes to) and
 * this decides. Each signal has a weight; together they make a verdict.
 *
 * Authentication results only ever add warnings. A "pass" never removes one,
 * so a forged Authentication-Results header gains a sender nothing.
 */

export type AuthResult = 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'temperror' | 'permerror';
export type AuthSummary = {
	spf: AuthResult | null;
	dkim: AuthResult | null;
	dmarc: AuthResult | null;
	/**
	 * The From domain each DMARC result was about (header.from), lowercased.
	 * An empty string for a DMARC result that didn't say. A pass only vouches
	 * for these domains.
	 */
	dmarcFrom?: string[];
};

export type PhishingReasonCode =
	| 'own_domain_unverified'
	| 'dmarc_failed'
	| 'auth_failed'
	| 'lookalike_brand'
	| 'lookalike_own'
	| 'lookalike_contact'
	| 'lookalike_characters'
	| 'brand_name'
	| 'teammate_name'
	| 'name_mismatch'
	| 'money_ask'
	| 'reply_to_elsewhere';

export type PhishingReason = { code: PhishingReasonCode; weight: number; text: string };
export type PhishingVerdict = 'phishing' | 'suspicious';

/** What's stored on the message and shown above it. */
export type MessageSecurity = {
	auth: AuthSummary;
	verdict: PhishingVerdict | null;
	reasons: PhishingReason[];
	/**
	 * The receiving server's own Authentication-Results text (Cloudflare's or
	 * Resend's), captured when the mail arrived. The only source the details
	 * panel treats as checked: stored headers may hold the sender's fakes.
	 */
	authText?: string | null;
};

/** At or above: "Looks like phishing". */
export const PHISHING_SCORE = 3;
/** At or above: "Be careful". */
export const SUSPICIOUS_SCORE = 2;

const RESULTS = new Set<AuthResult>(['pass', 'fail', 'softfail', 'neutral', 'none', 'temperror', 'permerror']);

function asResult(value: string): AuthResult | null {
	const lower = value.toLowerCase() as AuthResult;
	return RESULTS.has(lower) ? lower : null;
}

export type AuthClause = { method: 'spf' | 'dkim' | 'dmarc'; result: string; props: Record<string, string> };

/**
 * What a report that can't be read safely counts as: every check failed with
 * an error, nothing vouched for. Fails closed, so a sender who leaves a quote
 * or comment open can't hide the receiver's real results behind it.
 */
/** How much of an Authentication-Results value is kept and read. */
export const MAX_AUTH_TEXT = 4096;

/**
 * At most `max` characters, cut only at a ";" so the last clause is never a
 * piece of one: "header.d=victim.com.attacker.net" cut short must not read as
 * victim.com. A ";" inside quotes leaves a quote open, which authClauses
 * treats as unreadable, so a bad cut fails closed.
 */
export function cutAuthText(text: string, max = MAX_AUTH_TEXT): string {
	if (text.length <= max) return text;
	const end = text.lastIndexOf(';', max);
	return end === -1 ? '' : text.slice(0, end);
}

function unreadable(): AuthClause[] {
	return (['spf', 'dkim', 'dmarc'] as const).map((method) => ({ method, result: 'permerror', props: {} }));
}

/**
 * The results in an Authentication-Results value, read the way RFC 8601 lays
 * them out. The sender controls some of the text a receiver writes there (the
 * envelope address appears in comments and in smtp.mailfrom, quoted local
 * parts and all), so a naive split on ";" lets them add a result of their own:
 * `"x;dmarc=pass header.from=victim.test"@evil.test`. Here comments are dropped,
 * ";" splits only outside quotes and comments, a result counts only at the
 * start of its own clause, and properties are read outside quoted strings.
 */
export function authClauses(text: string | null | undefined): AuthClause[] {
	if (!text) return [];
	const source = cutAuthText(text, 2 * MAX_AUTH_TEXT);
	const parts: Array<{ text: string; mask: string }> = [];
	let kept = '';
	let mask = '';
	let quoted = false;
	let depth = 0;
	for (let i = 0; i < source.length; i += 1) {
		const char = source[i];
		if (quoted) {
			if (char === '\\' && i + 1 < source.length) {
				if (depth === 0) {
					kept += char + source[i + 1];
					mask += 'xx';
				}
				i += 1;
				continue;
			}
			if (char === '"') quoted = false;
			if (depth === 0) {
				kept += char;
				mask += char === '"' ? '"' : 'x';
			}
			continue;
		}
		if (char === '"') {
			quoted = true;
			if (depth === 0) {
				kept += char;
				mask += char;
			}
			continue;
		}
		// A quoted-pair inside a comment: "\)" doesn't close it.
		if (char === '\\' && depth > 0) {
			i += 1;
			continue;
		}
		if (char === '(') {
			depth += 1;
			continue;
		}
		if (char === ')') {
			if (depth === 0) return unreadable();
			depth -= 1;
			if (depth === 0) {
				kept += ' ';
				mask += ' ';
			}
			continue;
		}
		if (depth > 0) continue;
		if (char === ';') {
			parts.push({ text: kept, mask });
			kept = '';
			mask = '';
			continue;
		}
		kept += char;
		mask += char;
	}
	// Text left open could have swallowed the receiver's own results.
	if (quoted || depth > 0) return unreadable();
	parts.push({ text: kept, mask });

	const found: AuthClause[] = [];
	for (const part of parts) {
		const spec = part.mask.match(/^\s*(spf|dkim|dmarc)(?:\/\d+)?\s*=\s*([a-z]+)/i);
		if (!spec) continue;
		const props: Record<string, string> = {};
		// A value is a token, a quoted string, or both run together ("a b"@example.com).
		for (const prop of part.mask.matchAll(/(?:^|\s)([a-z]+\.[a-z-]+)\s*=\s*((?:"[^"]*"|[^\s"])+)/gi)) {
			const start = (prop.index ?? 0) + prop[0].length - prop[2].length;
			const raw = part.text.slice(start, start + prop[2].length);
			const value = /^"[^"]*"$/.test(prop[2]) ? raw.slice(1, -1) : raw;
			const key = prop[1].toLowerCase();
			if (!(key in props)) props[key] = value.toLowerCase();
		}
		found.push({ method: spec[1].toLowerCase() as AuthClause['method'], result: spec[2].toLowerCase(), props });
	}
	return found;
}

/**
 * Reads Authentication-Results (RFC 8601) and Received-SPF headers. Several
 * headers, or one with several results, are combined so a failure wins: a
 * sender can add a fake "pass", but can't hide the receiver's "fail".
 */
export function parseAuthResults(authResults: string[], receivedSpf: string[] = []): AuthSummary {
	const found: Record<'spf' | 'dkim' | 'dmarc', AuthResult[]> = { spf: [], dkim: [], dmarc: [] };
	const dmarcFrom = new Set<string>();
	for (const header of authResults) {
		// Belt and braces: a failure anywhere in the plain text still counts, so
		// no way of reading the header can turn the receiver's "fail" into a pass.
		for (const raw of cutAuthText(header, 2 * MAX_AUTH_TEXT).split(';')) {
			const match = raw.match(/\b(spf|dkim|dmarc)\s*=\s*(fail|softfail|permerror)\b/i);
			if (match) found[match[1].toLowerCase() as 'spf' | 'dkim' | 'dmarc'].push(match[2].toLowerCase() as AuthResult);
		}
		for (const clause of authClauses(header)) {
			const result = asResult(clause.result);
			if (!result) continue;
			found[clause.method].push(result);
			if (clause.method === 'dmarc') {
				const from = clause.props['header.from'] ?? '';
				dmarcFrom.add(/^[a-z0-9.-]+$/.test(from) ? from.replace(/\.$/, '') : '');
			}
		}
	}
	for (const header of receivedSpf) {
		const result = asResult(header.trim().split(/[\s(;]/)[0] ?? '');
		if (result) found.spf.push(result);
	}
	const worst = (results: AuthResult[]): AuthResult | null => {
		if (results.length === 0) return null;
		for (const bad of ['fail', 'softfail', 'permerror', 'temperror', 'neutral', 'none'] as const) {
			if (results.includes(bad)) return bad;
		}
		return 'pass';
	};
	return { spf: worst(found.spf), dkim: worst(found.dkim), dmarc: worst(found.dmarc), dmarcFrom: [...dmarcFrom] };
}

/**
 * Whether the message provably comes from its From domain, for deciding if a
 * teammate is giving an agent instructions. Only DMARC counts: it checks the
 * signature or sender against the From domain itself, and the results are
 * combined worst-first, so a forged "pass" a sender adds to their own message
 * can't outvote the receiving server's real result. A DKIM pass alone proves
 * only that someone signed, possibly with their own domain.
 */
export function fromDomainVerified(auth: AuthSummary | null | undefined, fromAddress: string): boolean {
	if (auth?.dmarc !== 'pass') return false;
	// The pass has to be about this sender's domain. CloudMail may store the envelope sender,
	// and DMARC vouches for the header From: if they differ, the pass says nothing about this address.
	const domain = fromAddress.trim().toLowerCase().split('@').pop()?.replace(/\.$/, '') ?? '';
	const about = auth.dmarcFrom ?? [];
	return !!domain && about.length > 0 && about.every((item) => item === domain);
}

/** Brands phishers imitate most. Short names only match exactly, to avoid false alarms. */
const BRANDS: Array<{ name: string; label: string; domains: string[] }> = [
	{ name: 'PayPal', label: 'paypal', domains: ['paypal.com', 'paypal.me'] },
	{ name: 'Google', label: 'google', domains: ['google.com', 'gmail.com', 'googlemail.com', 'youtube.com'] },
	{ name: 'Microsoft', label: 'microsoft', domains: ['microsoft.com', 'outlook.com', 'live.com', 'office.com', 'microsoftonline.com', 'office365.com', 'hotmail.com'] },
	{ name: 'Apple', label: 'apple', domains: ['apple.com', 'icloud.com', 'me.com'] },
	{ name: 'Amazon', label: 'amazon', domains: ['amazon.com', 'amazonses.com', 'amazonaws.com', 'amazon.co.uk', 'amazon.de', 'amazon.ca'] },
	{ name: 'Stripe', label: 'stripe', domains: ['stripe.com'] },
	{ name: 'DocuSign', label: 'docusign', domains: ['docusign.com', 'docusign.net'] },
	{ name: 'Dropbox', label: 'dropbox', domains: ['dropbox.com', 'dropboxmail.com'] },
	{ name: 'Chase', label: 'chase', domains: ['chase.com', 'jpmorganchase.com'] },
	{ name: 'Wells Fargo', label: 'wellsfargo', domains: ['wellsfargo.com'] },
	{ name: 'Bank of America', label: 'bankofamerica', domains: ['bankofamerica.com', 'bofa.com'] },
	{ name: 'Netflix', label: 'netflix', domains: ['netflix.com'] },
	{ name: 'LinkedIn', label: 'linkedin', domains: ['linkedin.com'] },
	{ name: 'Facebook', label: 'facebook', domains: ['facebook.com', 'facebookmail.com', 'meta.com'] },
	{ name: 'Instagram', label: 'instagram', domains: ['instagram.com'] },
	{ name: 'Adobe', label: 'adobe', domains: ['adobe.com'] },
	{ name: 'Intuit', label: 'intuit', domains: ['intuit.com'] },
	{ name: 'QuickBooks', label: 'quickbooks', domains: ['quickbooks.com', 'intuit.com'] },
	{ name: 'FedEx', label: 'fedex', domains: ['fedex.com'] },
	{ name: 'Coinbase', label: 'coinbase', domains: ['coinbase.com'] },
	{ name: 'Shopify', label: 'shopify', domains: ['shopify.com'] },
	{ name: 'Cloudflare', label: 'cloudflare', domains: ['cloudflare.com'] }
];

/** Free mailbox providers: anyone can sign up as any name there. */
const FREE_MAIL = new Set([
	'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com',
	'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com', 'yandex.com', 'zoho.com'
]);

/** Folds characters phishers swap in: 0→o, 1/i→l, 3→e, 5→s, rn→m, vv→w. */
export function skeleton(label: string): string {
	return label
		.toLowerCase()
		.replace(/rn/g, 'm')
		.replace(/vv/g, 'w')
		.replace(/0/g, 'o')
		.replace(/[1i|]/g, 'l')
		.replace(/3/g, 'e')
		.replace(/5/g, 's')
		.replace(/-/g, '');
}

/** `candidate` is made to look like `real` without being it. */
export function looksLike(candidate: string, real: string): boolean {
	const a = candidate.toLowerCase();
	const b = real.toLowerCase();
	if (a === b) return false;
	if (skeleton(a) === skeleton(b)) return true;
	// One typo is only meaningful on names long enough not to collide by chance.
	return b.length >= 5 && oneEditAway(a, b);
}

/** The name part of a registrable domain: "paypal" for paypal-secure.com's "paypal-secure". */
function nameOf(domain: string): string {
	return registrableDomain(domain).split('.')[0] ?? '';
}

/**
 * The brand a domain imitates. `strong` when the whole name is the brand or a
 * misspelling of it (paypa1.com, paypal.net); weak when the brand is only one
 * word in it (paypal-secure.com), since real businesses do that too (apple-orchard.com).
 */
function brandFor(domain: string): { brand: (typeof BRANDS)[number]; strong: boolean } | null {
	const registrable = registrableDomain(domain);
	const name = nameOf(domain);
	const parts = name.split('-').filter(Boolean);
	for (const brand of BRANDS) {
		if (brand.domains.some((legit) => registrableDomain(legit) === registrable)) continue;
		const short = brand.label.length < 5;
		if (name === brand.label || (!short && looksLike(name, brand.label))) return { brand, strong: true };
		if (parts.length > 1 && parts.some((part) => part === brand.label || (!short && looksLike(part, brand.label)))) {
			return { brand, strong: false };
		}
	}
	return null;
}

const MONEY_ASK = [
	/\bwire (transfer|the (funds|payment))\b/i,
	/\b(bank|banking|account|payment|remittance) (details|information|info) (have |has )?(changed|updated)\b/i,
	/\bnew (bank|banking) (details|account)\b/i,
	/\bgift ?cards?\b/i,
	/\b(overdue|outstanding|unpaid) (invoice|payment|balance)\b/i,
	/\bverify your (account|identity|password|payment)\b/i,
	/\b(account|mailbox) (has been |will be )?(suspended|locked|disabled|deactivated|closed)\b/i,
	/\bpassword (expires|expired|will expire)\b/i,
	/\b(unusual|suspicious) (sign-?in|login|activity)\b/i,
	/\b(bitcoin|crypto(currency)?|usdt) (payment|wallet|transfer)\b/i,
	/\bconfirm your (login|credentials|payment details)\b/i
];

export type AssessInput = {
	fromAddress: string;
	fromName: string | null;
	replyTo: string | null;
	subject: string;
	text: string;
	auth: AuthSummary;
	/** Domains this CloudMail serves. */
	ownDomains: string[];
	/** Names of people in the workspace, to catch "your CEO" from a gmail address. */
	teammateNames: string[];
	/** Domains the user has written to: their real contacts. */
	contactDomains: string[];
	/** Nobody in this mailbox has written to or heard from this address before. */
	firstTimeSender: boolean;
};

function domainOf(address: string): string {
	return (address.split('@')[1] ?? '').trim().toLowerCase();
}

export function assessMessage(input: AssessInput): MessageSecurity {
	const reasons: PhishingReason[] = [];
	const add = (code: PhishingReasonCode, weight: number, text: string) => reasons.push({ code, weight, text });

	const fromDomain = domainOf(input.fromAddress);
	const fromRegistrable = registrableDomain(fromDomain);
	const own = new Set(input.ownDomains.map((domain) => registrableDomain(domain)));
	const { spf, dkim, dmarc } = input.auth;
	const authKnown = spf !== null || dkim !== null || dmarc !== null;
	const failed = (result: AuthResult | null) => result === 'fail' || result === 'softfail' || result === 'permerror';

	// 1. Proof of sender.
	if (own.has(fromRegistrable)) {
		if (authKnown && (failed(dmarc) || (dkim !== 'pass' && spf !== 'pass'))) {
			add('own_domain_unverified', 3, `It claims to be from your own domain (${fromRegistrable}), but it isn't signed by it.`);
		}
	} else if (failed(dmarc)) {
		add('dmarc_failed', 2, `${fromRegistrable} says this message didn't come from them.`);
	} else if (failed(spf) && dkim !== 'pass') {
		add('auth_failed', 1, `It wasn't sent by a server ${fromRegistrable} uses.`);
	}

	// 2. Lookalike sender domain.
	if (fromDomain.includes('xn--') || mixedScripts(fromDomain)) {
		add('lookalike_characters', 2, `The sender's address uses lookalike characters (${fromDomain}).`);
	}
	const imitated = brandFor(fromDomain);
	if (imitated) {
		add(
			'lookalike_brand',
			imitated.strong ? 3 : 1,
			imitated.strong
				? `${fromRegistrable} looks like ${imitated.brand.name}, but isn't one of its domains.`
				: `${fromRegistrable} uses ${imitated.brand.name}'s name, but isn't one of its domains.`
		);
	} else if (!own.has(fromRegistrable)) {
		const ownTwin = [...own].find((domain) => looksLike(nameOf(fromRegistrable), nameOf(domain)));
		if (ownTwin) {
			add('lookalike_own', 3, `${fromRegistrable} looks like your own domain, ${ownTwin}.`);
		} else {
			const contacts = new Set(input.contactDomains.map((domain) => registrableDomain(domain)));
			if (!contacts.has(fromRegistrable)) {
				const twin = [...contacts].find(
					(domain) => !FREE_MAIL.has(domain) && looksLike(nameOf(fromRegistrable), nameOf(domain))
				);
				if (twin) add('lookalike_contact', 2, `${fromRegistrable} looks like ${twin}, a domain you write to.`);
			}
		}
	}

	// 3. A name that claims to be someone else.
	const name = input.fromName?.trim() ?? '';
	if (name) {
		const mismatch = senderWarning(`${name} <${input.fromAddress}>`);
		if (mismatch) add('name_mismatch', 2, mismatch);
		const claimed = BRANDS.find(
			(item) =>
				new RegExp(`\\b${item.name.replace(/ /g, '\\s*')}\\b`, 'i').test(name) &&
				!item.domains.some((legit) => registrableDomain(legit) === fromRegistrable)
		);
		if (claimed && !imitated?.strong) add('brand_name', 2, `It's signed "${name}", but comes from ${fromRegistrable}, not ${claimed.name}.`);
		const teammate = input.teammateNames.find(
			(person) => person.trim().length >= 3 && person.trim().toLowerCase() === name.toLowerCase()
		);
		if (teammate && !own.has(fromRegistrable)) {
			add('teammate_name', 2, `It uses the name of ${teammate}, from your team, but comes from ${fromRegistrable}.`);
		}
	}

	// 4. A stranger asking for money or credentials.
	const body = `${input.subject}\n${input.text.slice(0, 8000)}`;
	const ask = MONEY_ASK.find((pattern) => pattern.test(body));
	if (ask && input.firstTimeSender) {
		add('money_ask', 2, 'A first-time sender is asking about payments, bank details, or your login.');
	}

	// 5. Replies would go somewhere else.
	const replyDomain = input.replyTo ? domainOf(input.replyTo.match(/<([^>]+)>/)?.[1] ?? input.replyTo) : '';
	if (replyDomain && registrableDomain(replyDomain) !== fromRegistrable && input.firstTimeSender) {
		add('reply_to_elsewhere', 1, `Replies would go to ${registrableDomain(replyDomain)}, not ${fromRegistrable}.`);
	}

	const score = reasons.reduce((sum, reason) => sum + reason.weight, 0);
	const verdict: PhishingVerdict | null =
		score >= PHISHING_SCORE ? 'phishing' : score >= SUSPICIOUS_SCORE ? 'suspicious' : null;
	reasons.sort((a, b) => b.weight - a.weight);
	return { auth: input.auth, verdict, reasons };
}

/** Stored JSON back to a value the reader can trust the shape of. */
export function parseSecurity(json: string | null | undefined): MessageSecurity | null {
	if (!json) return null;
	try {
		const value = JSON.parse(json) as MessageSecurity;
		if (!value || !Array.isArray(value.reasons)) return null;
		const verdict = value.verdict === 'phishing' || value.verdict === 'suspicious' ? value.verdict : null;
		const reasons = value.reasons
			.filter((reason) => reason && typeof reason.text === 'string' && typeof reason.code === 'string')
			.slice(0, 10);
		const read: MessageSecurity = { auth: value.auth ?? { spf: null, dkim: null, dmarc: null }, verdict, reasons };
		if (typeof value.authText === 'string') read.authText = cutAuthText(value.authText);
		return read;
	} catch {
		return null;
	}
}

/** The name Cloudflare Email Routing signs its results with. */
export const CLOUDFLARE_AUTHSERV_ID = 'mx.cloudflare.net';

/**
 * Cloudflare Email Routing's own SPF, DKIM and DMARC results for a message, from
 * the raw MIME, as Authentication-Results text. Email Routing doesn't hand a Worker
 * an Authentication-Results header; it records what it checked in the ARC set it
 * adds on top of the message. Each hop adds its headers above the ones already
 * there, so the first ARC-Authentication-Results from the top is the one Cloudflare
 * just added, and anything a sender wrote sits below it. Only that header counts,
 * and only when it names Cloudflare: a sender can't put a header above it.
 *
 * Checking the ARC-Seal signature wouldn't add to this: a sender could copy a
 * genuine Cloudflare-sealed set from mail they once received, and only being on
 * top tells a fresh set from a copied one. What this relies on is Cloudflare
 * adding its set to every message it routes; booking changes still wait for a
 * person's OK by default.
 */
export function cloudflareAuthResults(raw: ArrayBuffer | Uint8Array | string): string | null {
	const text =
		typeof raw === 'string'
			? raw.slice(0, 256 * 1024)
			: new TextDecoder().decode((raw instanceof Uint8Array ? raw : new Uint8Array(raw)).subarray(0, 256 * 1024));
	const end = text.search(/\r?\n\r?\n/);
	const head = end === -1 ? text : text.slice(0, end);
	// Unfold continuation lines, then walk the headers in order.
	const lines = head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/);
	for (const line of lines) {
		const match = line.match(/^arc-authentication-results\s*:\s*(.*)$/i);
		if (!match) continue;
		// "i=1; mx.cloudflare.net; dkim=pass ...": instance, then who checked.
		const [instance, authserv, ...results] = match[1].split(';');
		const index = Number(instance.trim().match(/^i\s*=\s*(\d+)$/i)?.[1]);
		// ARC stops at 50 hops; a set at 50 can't have had Cloudflare's added above it.
		if (!Number.isInteger(index) || index < 1 || index >= 50) return null;
		if (authserv?.trim().toLowerCase() !== CLOUDFLARE_AUTHSERV_ID) return null;
		return `${CLOUDFLARE_AUTHSERV_ID}; ${results.join(';').trim()}`;
	}
	return null;
}

/** Resend's words for a result, in RFC 8601's. */
const RESEND_RESULTS: Record<string, AuthResult> = {
	pass: 'pass',
	fail: 'fail',
	gray: 'neutral',
	processing_failed: 'temperror',
	unknown: 'none'
};

/**
 * Resend's own SPF, DKIM and DMARC results for received mail, as
 * Authentication-Results text. DMARC checks the header From domain by
 * definition, so a pass is about the From address's domain.
 */
export function resendAuthResults(
	authentication: { spf?: string | null; dkim?: string | null; dmarc?: string | null } | null | undefined,
	fromAddress: string
): string | null {
	if (!authentication) return null;
	const domain = fromAddress.trim().toLowerCase().split('@').pop()?.replace(/\.$/, '') ?? '';
	const clauses: string[] = [];
	for (const method of ['spf', 'dkim', 'dmarc'] as const) {
		const result = RESEND_RESULTS[(authentication[method] ?? '').toLowerCase()];
		if (!result) continue;
		clauses.push(method === 'dmarc' && domain ? `dmarc=${result} header.from=${domain}` : `${method}=${result}`);
	}
	return clauses.length ? `resend; ${clauses.join('; ')}` : null;
}
