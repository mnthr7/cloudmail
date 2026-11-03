export function parseUnsubscribe(header: string | null): {
	https: string | null;
	mailto: string | null;
	subject: string | null;
} {
	let https: string | null = null;
	let mailto: string | null = null;
	let subject: string | null = null;
	for (const match of header?.matchAll(/<([^>]+)>/g) ?? []) {
		const value = match[1]?.trim() ?? '';
		if (!https && value.toLowerCase().startsWith('https://')) https = value;
		if (!mailto && value.toLowerCase().startsWith('mailto:')) {
			const parsed = parseMailto(value);
			mailto = parsed.address;
			subject = parsed.subject;
		}
	}
	return { https, mailto, subject };
}

/** Address stays as written. `subject` is the mailto query parameter, when present. */
function parseMailto(value: string): { address: string | null; subject: string | null } {
	const rest = value.slice('mailto:'.length);
	const splitAt = rest.indexOf('?');
	const address = (splitAt === -1 ? rest : rest.slice(0, splitAt)).trim() || null;
	if (!address) return { address: null, subject: null };
	const query = splitAt === -1 ? '' : rest.slice(splitAt + 1);
	const subject = new URLSearchParams(query).get('subject')?.trim() || null;
	return { address, subject };
}

export function publicHttpsError(url: string): 'https' | 'private' | 'invalid' | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return 'invalid';
	}
	if (parsed.protocol !== 'https:') return 'https';
	const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.localhost')) return 'private';
	if (isPrivateIp(host)) return 'private';
	return null;
}

function isPrivateIp(host: string): boolean {
	const mapped = ipv4Mapped(host);
	if (mapped) return isPrivateIpv4(mapped);
	// `fc`/`fd` are unique-local IPv6 prefixes. Hostnames such as fda.gov share
	// those letters and stay public.
	if (host.includes(':')) {
		return host === '::1' || host.startsWith('fe80:') || host.startsWith('fd') || host.startsWith('fc');
	}
	return isPrivateIpv4(host);
}

/**
 * The last 32 bits of an IPv4-mapped address (`::ffff:127.0.0.1`).
 * `URL` serializes that as `::ffff:7f00:1`.
 */
function ipv4Mapped(host: string): string | null {
	const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
	if (dotted?.[1] && ipv4Parts(dotted[1])) return dotted[1];

	const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
	if (!hex?.[1] || !hex[2]) return null;
	const hi = Number.parseInt(hex[1], 16);
	const lo = Number.parseInt(hex[2], 16);
	return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

function isPrivateIpv4(host: string): boolean {
	const parts = ipv4Parts(host);
	if (!parts) return false;
	const [a, b] = parts;
	if (a === 10 || a === 127 || a === 0) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 100 && b >= 64 && b <= 127) return true;
	return false;
}

function ipv4Parts(host: string): [number, number, number, number] | null {
	const parts = host.split('.').map((part) => Number(part));
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
		return null;
	}
	return [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
}
