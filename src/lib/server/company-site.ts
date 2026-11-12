import { stripHtml } from './html.ts';

/**
 * A look at a guest's company homepage, for the prep brief (demo spec, R11).
 * The only page fetched is the home page of the domain in the guest's own
 * email address, over HTTPS, so nothing a guest writes can point the server
 * anywhere else. What comes back is the company's own words, and untrusted:
 * it goes to the model marked as data and to the host as a quote.
 */

export type CompanySite =
	| { status: 'site'; domain: string; url: string; title: string; description: string; text: string }
	/** A free mail domain like gmail.com: there's no company site to look up. */
	| { status: 'personal'; domain: string }
	| { status: 'unreachable'; domain: string; reason: string };

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** Mail domains anyone can sign up for, so the domain says nothing about the company. */
const FREE_MAIL = new Set([
	'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'rocketmail.com', 'outlook.com', 'hotmail.com', 'live.com',
	'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net',
	'gmx.de', 'web.de', 'yandex.com', 'yandex.ru', 'mail.ru', 'fastmail.com', 'hey.com', 'tutanota.com', 'tuta.io',
	'zoho.com', 'qq.com', '163.com', '126.com', 'naver.com', 'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net',
	'btinternet.com', 'orange.fr', 'free.fr', 'laposte.net', 'libero.it', 't-online.de', 'rediffmail.com', 'yahoo.co.uk',
	'yahoo.co.in', 'hotmail.co.uk', 'outlook.de', 'live.co.uk'
]);

/** Top-level names that never reach a public site. */
const RESERVED_TLDS = new Set(['localhost', 'local', 'internal', 'invalid', 'example', 'test', 'onion', 'lan', 'home', 'corp', 'intranet', 'arpa']);

const TIMEOUT_MS = 5000;
/** Most of a home page read. The title, description and opening text are near the top. */
const MAX_BYTES = 64 * 1024;
const MAX_REDIRECTS = 3;
const MAX_TEXT = 2000;

/**
 * A hostname that can only be a public site: letters, digits and hyphens in
 * dot-separated labels, an alphabetic top-level name that isn't reserved, so
 * never an IP address, localhost or a bare internal name.
 */
export function publicHost(value: string): string | null {
	const host = value.trim().toLowerCase().replace(/\.$/, '');
	if (host.length > 253) return null;
	const labels = host.split('.');
	if (labels.length < 2) return null;
	if (!labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
	const tld = labels[labels.length - 1];
	if (!/^[a-z]{2,63}$/.test(tld) || RESERVED_TLDS.has(tld)) return null;
	return host;
}

export function isFreeMail(domain: string): boolean {
	const host = domain.toLowerCase();
	return FREE_MAIL.has(host) || /^(yahoo|hotmail|outlook|live)\.[a-z.]+$/.test(host);
}

/*
 * The page is someone else's, so it's read without regular expressions that
 * can backtrack across it: every step below is a forward scan with indexOf,
 * or a regex on one short tag at a time.
 */

function clean(text: string, max: number): string {
	return stripHtml(text).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** The text between the first <tag ...> and its </tag>, or ''. `lower` is `html` lowercased. */
function inner(html: string, lower: string, tag: string): string {
	const open = lower.indexOf(`<${tag}`);
	if (open === -1) return '';
	const start = lower.indexOf('>', open);
	const close = start === -1 ? -1 : lower.indexOf(`</${tag}`, start);
	return close === -1 ? '' : html.slice(start + 1, close);
}

/** Every complete tag that starts with `<tag`, each at most 1000 characters. */
function tags(html: string, lower: string, tag: string): string[] {
	const out: string[] = [];
	let from = 0;
	while (out.length < 100) {
		const open = lower.indexOf(`<${tag}`, from);
		if (open === -1) break;
		const close = lower.indexOf('>', open);
		if (close === -1) break;
		if (close - open < 1000) out.push(html.slice(open, close + 1));
		from = close + 1;
	}
	return out;
}

function meta(html: string, lower: string, name: string): string {
	for (const tag of tags(html, lower, 'meta')) {
		const key = tag.match(/\b(?:name|property)\s*=\s*["']([^"']{1,100})["']/i)?.[1];
		if (key?.toLowerCase() !== name) continue;
		const content = tag.match(/\bcontent\s*=\s*["']([^"']{0,900})["']/i)?.[1];
		if (content) return clean(content, 300);
	}
	return '';
}

/** The page with these elements and everything inside them taken out. Unclosed ones run to the end. */
function dropElements(html: string, names: string[]): string {
	const lower = html.toLowerCase();
	let out = '';
	let at = 0;
	while (at < html.length) {
		let next = -1;
		let name = '';
		for (const candidate of names) {
			const index = lower.indexOf(`<${candidate}`, at);
			if (index !== -1 && (next === -1 || index < next)) {
				next = index;
				name = candidate;
			}
		}
		if (next === -1) {
			out += html.slice(at);
			break;
		}
		out += html.slice(at, next) + ' ';
		const close = lower.indexOf(`</${name}`, next);
		if (close === -1) break;
		const end = lower.indexOf('>', close);
		at = end === -1 ? html.length : end + 1;
	}
	return out;
}

async function readCapped(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return '';
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (size < MAX_BYTES) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		size += value.byteLength;
	}
	await reader.cancel().catch(() => undefined);
	const all = new Uint8Array(Math.min(size, MAX_BYTES));
	let offset = 0;
	for (const chunk of chunks) {
		const part = chunk.subarray(0, all.length - offset);
		all.set(part, offset);
		offset += part.length;
		if (offset >= all.length) break;
	}
	return new TextDecoder().decode(all);
}

/** Fetches one https URL, following a few redirects only to other public https hosts. */
async function fetchPublic(fetcher: Fetcher, start: string): Promise<{ response: Response; url: string } | { reason: string }> {
	let url = start;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		let response: Response;
		try {
			response = await fetcher(url, {
				method: 'GET',
				redirect: 'manual',
				headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'CloudMail-PrepBrief/1.0' },
				signal: AbortSignal.timeout(TIMEOUT_MS)
			});
		} catch (error) {
			return { reason: error instanceof Error && error.name === 'TimeoutError' ? 'it took too long to answer' : 'it could not be reached' };
		}
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get('location');
			let next: URL;
			try {
				next = new URL(location ?? '', url);
			} catch {
				return { reason: 'it redirected somewhere invalid' };
			}
			if (next.protocol !== 'https:' || next.port || next.username || next.password || !publicHost(next.hostname)) {
				return { reason: 'it redirected somewhere we don’t follow' };
			}
			url = next.toString();
			continue;
		}
		if (!response.ok) return { reason: `it answered with an error (${response.status})` };
		return { response, url };
	}
	return { reason: 'it redirected too many times' };
}

/** What the guest's company says about itself on its home page, or why we couldn't tell. */
export async function lookUpCompany(guestEmail: string, fetcher: Fetcher): Promise<CompanySite> {
	const raw = guestEmail.slice(guestEmail.lastIndexOf('@') + 1);
	const domain = publicHost(raw);
	if (!domain) return { status: 'unreachable', domain: raw.toLowerCase(), reason: 'the address’s domain isn’t a public website' };
	if (isFreeMail(domain)) return { status: 'personal', domain };

	let found = await fetchPublic(fetcher, `https://${domain}/`);
	if ('reason' in found && !domain.startsWith('www.')) {
		const again = await fetchPublic(fetcher, `https://www.${domain}/`);
		if (!('reason' in again)) found = again;
	}
	if ('reason' in found) return { status: 'unreachable', domain, reason: found.reason };

	const type = found.response.headers.get('content-type') ?? '';
	if (!/text\/html|application\/xhtml\+xml/i.test(type)) {
		await found.response.body?.cancel().catch(() => undefined);
		return { status: 'unreachable', domain, reason: 'its home page isn’t a web page' };
	}
	const html = await readCapped(found.response);
	const lower = html.toLowerCase();
	const title = clean(inner(html, lower, 'title'), 300) || meta(html, lower, 'og:site_name');
	const description = meta(html, lower, 'description') || meta(html, lower, 'og:description');
	const bodyAt = lower.indexOf('<body');
	const body = bodyAt === -1 ? html : html.slice(bodyAt);
	const text = stripHtml(dropElements(body, ['script', 'style', 'nav', 'footer', 'header', 'noscript', 'svg', 'template']))
		.replace(/[ \t]+/g, ' ')
		.replace(/\n\s*\n+/g, '\n')
		.trim()
		.slice(0, MAX_TEXT);
	if (!title && !description && !text) return { status: 'unreachable', domain, reason: 'its home page was empty' };
	return { status: 'site', domain, url: found.url, title, description, text };
}
