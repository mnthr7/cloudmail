const LOCAL_PART = /^[a-z0-9._%+-]+$/i;

/** Display name beside a mailbox, or null when the value is only an address. */
export function displayNameFromHeader(value: string): string | null {
	const match = value.trim().match(/^(.*)<[^<>]*>\s*$/);
	if (!match) return null;
	return cleanDisplayName(match[1] ?? '');
}

/** Trim a display name. A surrounding quoted-string is the name inside the quotes. */
export function cleanDisplayName(value: string | null | undefined): string | null {
	if (value == null) return null;
	let name = value.trim();
	if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
		name = name.slice(1, -1).trim();
	}
	return name.length > 0 ? name : null;
}

export function parseEmailAddress(value: string): string {
	const trimmed = value.trim();
	const bracketMatch = trimmed.match(/<([^>]+)>/);
	if (bracketMatch) {
		return bracketMatch[1].toLowerCase().trim();
	}

	const emailMatch = trimmed.match(/[^\s<>]+@[^\s<>]+/);
	return (emailMatch?.[0] ?? trimmed).toLowerCase().trim();
}

export function parseEmailAddresses(value: string | string[] | null | undefined): string[] {
	if (!value) return [];

	const parts = Array.isArray(value) ? value : value.split(',');
	const addresses = new Set<string>();

	for (const part of parts) {
		const parsed = parseEmailAddress(part);
		if (parsed.includes('@')) {
			addresses.add(parsed);
		}
	}

	return [...addresses];
}

export function domainOf(address: string): string | null {
	const parsed = parseEmailAddress(address);
	const domain = parsed.split('@')[1];
	return domain || null;
}

export function localPartOf(address: string): string | null {
	const parsed = parseEmailAddress(address);
	const local = parsed.split('@')[0];
	return local || null;
}

/** Same rules Settings uses when claiming a sending identity. */
export function isValidLocalPart(localPart: string): boolean {
	return LOCAL_PART.test(localPart);
}

// Role mailboxes (RFC 2142 and common shared inboxes). Mail to them is for the
// whole domain, so only an admin may hand one out.
const RESERVED_LOCAL_PARTS = new Set([
	'abuse', 'admin', 'administrator', 'billing', 'hostmaster', 'info', 'mailer-daemon',
	'no-reply', 'noc', 'noreply', 'postmaster', 'root', 'security', 'support', 'webmaster'
]);

/** A role address only an admin may claim. Plus-tags count as the base name. */
export function isReservedLocalPart(localPart: string): boolean {
	const base = localPart.trim().toLowerCase().replace(/@.*$/, '').split('+')[0] ?? '';
	return RESERVED_LOCAL_PARTS.has(base);
}

/**
 * Every address an inbound Resend message could have been destined for.
 *
 * `received_for` is the address Resend actually accepted mail for (it survives
 * forwarding), so it is checked before the visible To/Cc headers.
 */
export function collectInboundRecipients(payload: {
	received_for?: string[] | null;
	to?: string[] | string | null;
	cc?: string[] | string | null;
	bcc?: string[] | string | null;
}): string[] {
	const recipients = new Set<string>();

	for (const source of [payload.received_for, payload.to, payload.cc, payload.bcc]) {
		for (const address of parseEmailAddresses(source ?? null)) {
			recipients.add(address);
		}
	}

	return [...recipients];
}
