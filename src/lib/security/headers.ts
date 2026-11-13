import { authClauses, type AuthSummary } from './security-result';

/**
 * A message's original headers, kept so the reader can see who really sent it.
 * Pure: the inbound paths store the header block, and the reader turns it into
 * plain facts. Anything a sender writes is labelled as their claim; only the
 * receiving server's own results count as checked.
 */

/** Enough for any real header block; a sender can't fill the row with junk. */
export const MAX_HEADER_BYTES = 64 * 1024;

export type HeaderLine = { name: string; value: string };

/** The header block of a raw MIME message: everything before the first blank line. */
export function headerBlockFromRaw(raw: ArrayBuffer | Uint8Array | string): string | null {
	const text =
		typeof raw === 'string'
			? raw.slice(0, MAX_HEADER_BYTES * 2)
			: new TextDecoder().decode(
					(raw instanceof Uint8Array ? raw : new Uint8Array(raw)).subarray(0, MAX_HEADER_BYTES * 2)
				);
	const end = text.search(/\r?\n\r?\n/);
	const block = (end === -1 ? text : text.slice(0, end)).replace(/\r\n/g, '\n');
	return capHeaders(block);
}

/** Headers handed over as a record (Resend), written back out as a header block. */
export function headerBlockFromRecord(record: Record<string, unknown> | null | undefined): string | null {
	if (!record) return null;
	const lines: string[] = [];
	for (const [name, value] of Object.entries(record)) {
		const values = Array.isArray(value) ? value : [value];
		for (const item of values) {
			if (typeof item === 'string' && item.trim()) lines.push(`${name}: ${item}`);
		}
	}
	return capHeaders(lines.join('\n'));
}

const CUT_MARKER = '\n[headers cut short]';

/** Trims, and keeps the block within MAX_HEADER_BYTES of UTF-8, marker included. */
function capHeaders(block: string): string | null {
	const trimmed = block.trim();
	if (!trimmed) return null;
	const bytes = new TextEncoder().encode(trimmed);
	if (bytes.byteLength <= MAX_HEADER_BYTES) return trimmed;
	// Decode a byte prefix (a split character becomes U+FFFD), then cut at a line
	// so the last header isn't half a value.
	const room = MAX_HEADER_BYTES - new TextEncoder().encode(CUT_MARKER).byteLength;
	const cut = new TextDecoder().decode(bytes.subarray(0, room));
	return `${cut.slice(0, Math.max(cut.lastIndexOf('\n'), 0))}${CUT_MARKER}`;
}

/** Each header on one line, in the order it arrived (newest hop first). */
export function parseHeaderBlock(block: string | null | undefined): HeaderLine[] {
	if (!block) return [];
	const lines: HeaderLine[] = [];
	for (const line of block.replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ').split('\n')) {
		const colon = line.indexOf(':');
		if (colon <= 0) continue;
		const name = line.slice(0, colon).trim();
		if (!/^[\x21-\x39\x3b-\x7e]+$/.test(name)) continue;
		lines.push({ name, value: line.slice(colon + 1).trim() });
	}
	return lines;
}

function first(lines: HeaderLine[], name: string): string | null {
	const target = name.toLowerCase();
	return lines.find((line) => line.name.toLowerCase() === target)?.value || null;
}

function all(lines: HeaderLine[], name: string): string[] {
	const target = name.toLowerCase();
	return lines.filter((line) => line.name.toLowerCase() === target).map((line) => line.value);
}

function domainOfAddress(value: string | null | undefined): string | null {
	// Header values are the sender's; cap before any regex sees them.
	if (!value || value.length > 512) return null;
	const address = value.match(/<([^>]*)>/)?.[1] ?? value;
	const domain = address.trim().split('@').pop()?.trim().toLowerCase().replace(/[>.\s]+$/, '');
	return domain && domain.includes('.') && !domain.includes(' ') ? domain : null;
}

export type DomainFact = { domain: string; checked: boolean };

export type SenderDetails = {
	from: string | null;
	sender: string | null;
	returnPath: string | null;
	replyTo: string | null;
	to: string | null;
	cc: string | null;
	date: string | null;
	messageId: string | null;
	/** The server that sent it, from SPF. `checked` when the receiving server said so. */
	mailedBy: DomainFact | null;
	/** Domains that signed it (DKIM). `checked` when the signature was verified. */
	signedBy: DomainFact[];
	/** How many servers handed it on. */
	hops: number;
	/** The first server that got it from the sender, from the oldest Received line. */
	origin: string | null;
	/** Plain words when the From domain isn't the one that sent or signed it. */
	mismatch: string | null;
};

/** `key=value` properties in Authentication-Results text, per method clause. */
function clauses(authText: string | null) {
	return authClauses(authText);
}

/**
 * The facts a reader needs to judge a sender. `authText` is the receiving
 * server's own Authentication-Results, captured when the mail arrived. Nothing
 * in the stored header block is ever read as checked: Resend hands over the
 * sender's headers as-is, so even an ARC set on top could be theirs.
 */
export function senderDetails(block: string | null | undefined, authText: string | null = null): SenderDetails {
	const lines = parseHeaderBlock(block);
	const trusted = clauses(authText);

	const spfClause = trusted.find((clause) => clause.method === 'spf');
	const spfDomain = domainOfAddress(spfClause?.props['smtp.mailfrom']) ?? spfClause?.props['smtp.helo'] ?? null;
	const returnPath = first(lines, 'Return-Path');
	const mailedBy: DomainFact | null = spfDomain
		? { domain: spfDomain, checked: spfClause?.result === 'pass' }
		: domainOfAddress(returnPath)
			? { domain: domainOfAddress(returnPath)!, checked: false }
			: null;

	// One entry per domain; any verified signature from it counts, in any order.
	const signers = new Map<string, boolean>();
	for (const clause of trusted) {
		const domain = clause.method === 'dkim' ? (clause.props['header.d'] ?? domainOfAddress(clause.props['header.i'])) : null;
		if (!domain) continue;
		signers.set(domain, (signers.get(domain) ?? false) || clause.result === 'pass');
	}
	for (const signature of all(lines, 'DKIM-Signature')) {
		const domain = signature.slice(0, 2048).match(/(?:^|;)\s*d\s*=\s*([a-z0-9.-]+)/i)?.[1]?.toLowerCase();
		if (domain && !signers.has(domain)) signers.set(domain, false);
	}
	const signedBy: DomainFact[] = [...signers].map(([domain, checked]) => ({ domain, checked }));

	const received = all(lines, 'Received');
	const oldest = received.at(-1) ?? null;
	const origin = oldest?.slice(0, 1024).match(/^from\s+(.+?)\s+(?:by|with|id|for)\b/i)?.[1] ?? null;

	const from = first(lines, 'From');
	return {
		from,
		sender: first(lines, 'Sender'),
		returnPath,
		replyTo: first(lines, 'Reply-To'),
		to: first(lines, 'To'),
		cc: first(lines, 'Cc'),
		date: first(lines, 'Date'),
		messageId: first(lines, 'Message-ID'),
		mailedBy,
		signedBy,
		hops: received.length,
		origin,
		mismatch: mismatchNote(domainOfAddress(from), mailedBy, signedBy, trusted)
	};
}

/**
 * `domain` is the From domain itself or one of its subdomains: whoever runs the
 * From domain runs those too. Not a parent (example.com for mail.example.com)
 * and not a sibling (attacker.example.com for www.example.com): without a
 * public-suffix list there's no telling those apart from co.uk or github.io.
 */
function ownedBy(domain: string, home: string): boolean {
	return domain === home || domain.endsWith(`.${home}`);
}

function mismatchNote(
	fromDomain: string | null,
	mailedBy: DomainFact | null,
	signedBy: DomainFact[],
	trusted: ReturnType<typeof clauses>
): string | null {
	if (!fromDomain) return null;
	const home = fromDomain;
	// The receiving server's DMARC pass for this exact From domain already
	// settled alignment, with a real public-suffix list. Without one, only the
	// From domain itself or its own subdomains count.
	const dmarcPass = trusted.some((clause) => clause.method === 'dmarc' && clause.result === 'pass' && clause.props['header.from'] === home);
	const signedHome = signedBy.some((fact) => fact.checked && ownedBy(fact.domain, home));
	const sentHome = !!mailedBy?.checked && ownedBy(mailedBy.domain, home);
	if (dmarcPass || signedHome || sentHome) return null;
	const domains = [
		...new Set(
			[mailedBy, ...signedBy]
				.filter((fact): fact is DomainFact => !!fact)
				.map((fact) => fact.domain)
				.filter((domain) => !ownedBy(domain, home))
		)
	];
	// send.klaviyomail.com and klaviyomail.com read as one: name the parent.
	const others = domains.filter((domain) => !domains.some((other) => other !== domain && domain.endsWith(`.${other}`)));
	if (others.length === 0) return `It says it's from ${home}, but nothing in it proves ${home} sent it.`;
	return `It says it's from ${home}, but it was sent through ${others.join(' and ')}.`;
}

/** Each check's result in a word, with what it means. */
export function authLines(auth: AuthSummary | null | undefined): Array<{ method: 'SPF' | 'DKIM' | 'DMARC'; result: string; ok: boolean | null; note: string }> {
	if (!auth) return [];
	const about = auth.dmarcFrom?.filter(Boolean).join(', ');
	const rows: Array<{ method: 'SPF' | 'DKIM' | 'DMARC'; result: string; ok: boolean | null; note: string }> = [];
	const verdict = (result: string | null) => (result === 'pass' ? true : result === 'fail' || result === 'softfail' || result === 'permerror' ? false : null);
	if (auth.spf) rows.push({ method: 'SPF', result: auth.spf, ok: verdict(auth.spf), note: 'Was it sent from a server the sending domain allows?' });
	if (auth.dkim) rows.push({ method: 'DKIM', result: auth.dkim, ok: verdict(auth.dkim), note: 'Is it signed, and unchanged since?' });
	if (auth.dmarc) {
		rows.push({
			method: 'DMARC',
			result: auth.dmarc,
			ok: verdict(auth.dmarc),
			note: about ? `Does ${about} vouch for it?` : 'Does the From domain vouch for it?'
		});
	}
	return rows;
}
