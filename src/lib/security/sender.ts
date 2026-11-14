import { registrableDomain } from './host';

const FILE_SUFFIXES = new Set([
	'pdf', 'png', 'jpg', 'jpeg', 'gif', 'zip', 'txt', 'doc', 'docx', 'xls', 'xlsx', 'html', 'htm'
]);

/**
 * `organization` decides which domains count as the same sender. The default is
 * the cheap two-label guess that is safe to ship to the browser; the server's
 * phishing check passes the Public Suffix List version (organization.ts).
 */
export function senderWarning(
	fromHeader: string,
	organization: (host: string) => string = registrableDomain
): string | null {
	const parsed = splitFrom(fromHeader);
	if (!parsed.name) return null;
	const address = parsed.address.toLowerCase();
	const email = parsed.name.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0];
	if (email && email.toLowerCase() !== address) {
		return `This name includes ${email}, but the message is from ${address}.`;
	}
	for (const token of parsed.name.split(/\s+/)) {
		const domain = token.replace(/^[<(]+|[>),.]+$/g, '');
		if (!isDomain(domain)) continue;
		if (organization(domain) !== organization(address.split('@')[1] ?? '')) {
			return `This name includes ${domain}, but the message is from ${address}.`;
		}
	}
	return null;
}

function splitFrom(value: string): { name: string | null; address: string } {
	const match = value.match(/^(.*)<\s*([^>]+)\s*>\s*$/);
	if (!match) return { name: null, address: value.trim() };
	const name = match[1]?.trim().replace(/^"|"$/g, '') ?? '';
	return { name: name || null, address: match[2]?.trim() ?? '' };
}

function isDomain(token: string): boolean {
	const labels = token.toLowerCase().split('.');
	if (labels.length < 2) return false;
	const last = labels[labels.length - 1] ?? '';
	if (FILE_SUFFIXES.has(last) || last.length < 2 || !/^[a-z]+$/.test(last)) return false;
	return labels.every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
}
