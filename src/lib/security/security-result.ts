/**
 * The stored shape of a message's security check, and the reader for it. Kept
 * apart from phishing.ts so the browser can read a verdict without bundling the
 * checks themselves (and the Public Suffix List they use).
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
		// Anything at the limit may have been cut mid-clause by older code: not trusted.
		const authText = storableAuthText(value.authText);
		if (authText) read.authText = authText;
		return read;
	} catch {
		return null;
	}
}

export type AuthClause = { method: 'spf' | 'dkim' | 'dmarc'; result: string; props: Record<string, string> };

/**
 * What a report that can't be read safely counts as: every check failed with
 * an error, nothing vouched for. Fails closed, so a sender who leaves a quote
 * or comment open can't hide the receiver's real results behind it.
 */
/**
 * The longest Authentication-Results value that is read, or stored for the
 * details panel. A longer one is never cut down to fit: a sender who pads the
 * report could push the receiver's real "fail" past any cut, or leave half a
 * clause ("header.d=victim.com" of victim.com.attacker.net). It counts as
 * unreadable instead.
 */
export const MAX_AUTH_TEXT = 4096;

/** The text whole, or null when it's too long to trust. */
export function storableAuthText(text: string | null | undefined): string | null {
	return typeof text === 'string' && text.length < MAX_AUTH_TEXT ? text : null;
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
	if (text.length >= MAX_AUTH_TEXT) return unreadable();
	const source = text;
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
