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
		return { auth: value.auth ?? { spf: null, dkim: null, dmarc: null }, verdict, reasons };
	} catch {
		return null;
	}
}
