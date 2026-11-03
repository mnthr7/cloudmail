import { mixedScripts, oneEditAway, registrableDomain } from './host';

const BRANDS = [
	{ name: 'PayPal', domain: 'paypal.com', label: 'paypal' },
	{ name: 'Google', domain: 'google.com', label: 'google' },
	{ name: 'Microsoft', domain: 'microsoft.com', label: 'microsoft' },
	{ name: 'Apple', domain: 'apple.com', label: 'apple' },
	{ name: 'Amazon', domain: 'amazon.com', label: 'amazon' }
] as const;

export function linkWarning(visibleText: string, href: string): string | null {
	let url: URL;
	try {
		url = new URL(href);
	} catch {
		return null;
	}
	const protocol = url.protocol.toLowerCase();
	if (protocol !== 'http:' && protocol !== 'https:' && protocol !== 'mailto:') return null;

	const hrefHost = url.hostname;
	if (protocol === 'mailto:') {
		const visibleEmail = firstEmail(visibleText);
		if (visibleEmail) {
			const target = mailtoAddress(url);
			if (visibleEmail.toLowerCase() !== target.toLowerCase()) {
				return `This link goes to ${target}, not ${visibleEmail}.`;
			}
			return null;
		}
	}
	const visibleHost = firstHost(visibleText);
	if (visibleHost && registrableDomain(visibleHost) !== registrableDomain(hrefHost)) {
		return `This link goes to ${registrableDomain(hrefHost)}, not ${registrableDomain(visibleHost)}.`;
	}
	if (hrefHost.toLowerCase().includes('xn--') || mixedScripts(hrefHost)) {
		return 'This address uses lookalike characters.';
	}
	const brand = brandHit(hrefHost);
	if (!brand) return null;
	return `This address is not ${brand.name}. It goes to ${hrefHost}.`;
}

function brandHit(host: string): (typeof BRANDS)[number] | null {
	const normalized = host.trim().toLowerCase().replace(/\.$/, '');
	const bare = normalized.startsWith('www.') ? normalized.slice(4) : normalized;
	for (const brand of BRANDS) {
		if (bare === brand.domain || bare.endsWith(`.${brand.domain}`)) continue;
		const labels = bare.split('.').filter(Boolean);
		if (labels.some((label) => label === brand.label) || oneEditAway(labels[0] ?? '', brand.label)) {
			return brand;
		}
	}
	return null;
}

function mailtoAddress(url: URL): string {
	return (url.pathname.split('?')[0] ?? '').replace(/^\/+/, '');
}

function firstHost(text: string): string | null {
	const embedded = /https?:\/\/\S+/i.exec(text);
	if (embedded?.[0]) {
		try {
			return new URL(embedded[0]).hostname;
		} catch {
			// A bare domain below still counts.
		}
	}
	const bare = /\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/i.exec(text);
	return bare?.[1] ?? null;
}

function firstEmail(text: string): string | null {
	return /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.exec(text)?.[0] ?? null;
}
