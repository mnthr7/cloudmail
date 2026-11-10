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
	/** Domains whose DKIM signature passed (header.d, or the domain of header.i). Absent on older results. */
	dkimDomains?: string[];
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

/**
 * Reads Authentication-Results (RFC 8601) and Received-SPF headers. Several
 * headers, or one with several results, are combined so a failure wins: a
 * sender can add a fake "pass", but can't hide the receiver's "fail".
 */
export function parseAuthResults(authResults: string[], receivedSpf: string[] = []): AuthSummary {
	const found: Record<'spf' | 'dkim' | 'dmarc', AuthResult[]> = { spf: [], dkim: [], dmarc: [] };
	const dkimDomains = new Set<string>();
	for (const header of authResults) {
		// Each method's result and its properties sit between semicolons.
		for (const clause of header.split(';')) {
			const match = clause.match(/\b(spf|dkim|dmarc)\s*=\s*([a-z]+)/i);
			if (!match) continue;
			const method = match[1].toLowerCase() as 'spf' | 'dkim' | 'dmarc';
			const result = asResult(match[2]);
			if (!result) continue;
			found[method].push(result);
			if (method === 'dkim' && result === 'pass') {
				const domain =
					clause.match(/\bheader\.d\s*=\s*([a-z0-9.-]+)/i)?.[1] ??
					clause.match(/\bheader\.i\s*=\s*[^@\s;]*@([a-z0-9.-]+)/i)?.[1];
				if (domain) dkimDomains.add(domain.toLowerCase().replace(/\.$/, ''));
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
	return {
		spf: worst(found.spf),
		dkim: worst(found.dkim),
		dmarc: worst(found.dmarc),
		dkimDomains: [...dkimDomains]
	};
}

/**
 * Whether the message provably comes from its From domain: DMARC passed, or a
 * DKIM signature from that same domain passed and DMARC didn't fail. A DKIM
 * pass on its own isn't enough: anyone can sign with their own domain and put
 * someone else's address in From.
 */
export function fromDomainVerified(auth: AuthSummary | null | undefined, fromAddress: string): boolean {
	if (!auth) return false;
	if (auth.dmarc === 'pass') return true;
	if (auth.dmarc === 'fail' || auth.dmarc === 'softfail' || auth.dmarc === 'permerror') return false;
	const fromDomain = (fromAddress.split('@')[1] ?? '').trim().toLowerCase();
	if (!fromDomain) return false;
	const fromOrg = registrableDomain(fromDomain);
	return (auth.dkimDomains ?? []).some((domain) => registrableDomain(domain) === fromOrg);
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
		return { auth: value.auth ?? { spf: null, dkim: null, dmarc: null }, verdict, reasons };
	} catch {
		return null;
	}
}
