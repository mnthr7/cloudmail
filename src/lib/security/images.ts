export function holdRemoteImages(html: string): { html: string; held: boolean } {
	let held = false;
	let out = '';
	let i = 0;
	while (i < html.length) {
		const start = html.indexOf('<', i);
		if (start === -1) {
			out += html.slice(i);
			break;
		}
		out += html.slice(i, start);
		const tag = readTag(html, start);
		if (tag.held) held = true;
		out += tag.html;
		i = tag.end;
	}
	return { html: out, held };
}

function readTag(html: string, start: number): { html: string; end: number; held: boolean } {
	let i = start + 1;
	if (i >= html.length) return { html: '<', end: html.length, held: false };
	if (html.charAt(i) === '/') {
		const end = bracketAfter(html, i);
		return { html: html.slice(start, end), end, held: false };
	}

	const nameStart = i;
	while (i < html.length && !endsName(html.charAt(i))) i += 1;
	if (i === nameStart) return { html: '<', end: start + 1, held: false };

	const rewrite = equalsAscii(html, nameStart, i, 'img') || equalsAscii(html, nameStart, i, 'source');
	let out = rewrite ? html.slice(start, i) : '';
	let held = false;

	while (i < html.length) {
		const mark = i;
		while (i < html.length && isSpace(html.charAt(i))) i += 1;
		if (i >= html.length) return finish(html, start, html.length, out + html.slice(mark), held, rewrite);

		const char = html.charAt(i);
		if (char === '>') return finish(html, start, i + 1, out + html.slice(mark, i + 1), held, rewrite);
		if (char === '/') {
			let j = i + 1;
			while (j < html.length && isSpace(html.charAt(j))) j += 1;
			if (j >= html.length || html.charAt(j) === '>') {
				const end = j >= html.length ? html.length : j + 1;
				return finish(html, start, end, out + html.slice(mark, end), held, rewrite);
			}
			if (rewrite) out += html.slice(mark, i + 1);
			i += 1;
			continue;
		}

		const attrStart = i;
		while (i < html.length && !endsName(html.charAt(i))) i += 1;
		if (i === attrStart) {
			i += 1;
			if (rewrite) out += html.slice(mark, i);
			continue;
		}

		let eq = i;
		while (eq < html.length && isSpace(html.charAt(eq))) eq += 1;
		if (eq >= html.length || html.charAt(eq) !== '=') {
			if (rewrite) out += html.slice(mark, i);
			continue;
		}

		let valueStart = eq + 1;
		while (valueStart < html.length && isSpace(html.charAt(valueStart))) valueStart += 1;
		const value = readValue(html, valueStart);
		const kind = attrKind(html, attrStart, i);
		const decoded = kind ? decodeCharacterReferences(value.raw) : '';
		// src is one URL. srcset keeps candidate separators; each URL is judged on its own.
		const urlValue = kind === 'src' ? normalizeImageUrlValue(decoded) : decoded;
		if (rewrite && kind && isHeldValue(kind, urlValue)) {
			held = true;
			out += html.slice(mark, attrStart);
			if (out.length === 0 || !isSpace(out.charAt(out.length - 1))) out += ' ';
			const dataName = kind === 'src' ? 'data-qm-src' : 'data-qm-srcset';
			out += `${dataName}="${escapeAttr(stored(kind, urlValue))}"`;
		} else if (rewrite) {
			out += html.slice(mark, value.end);
		}
		i = value.end;
	}

	return finish(html, start, i, out, held, rewrite);
}

function finish(
	html: string,
	start: number,
	end: number,
	built: string,
	held: boolean,
	rewrite: boolean
): { html: string; end: number; held: boolean } {
	if (!rewrite) return { html: html.slice(start, end), end, held: false };
	return { html: built, end, held };
}

function bracketAfter(html: string, from: number): number {
	const end = html.indexOf('>', from);
	return end === -1 ? html.length : end + 1;
}

function readValue(html: string, rawStart: number): { raw: string; end: number } {
	if (rawStart >= html.length) return { raw: '', end: rawStart };
	const quote = html.charAt(rawStart);
	if (quote === '"' || quote === "'") {
		let end = rawStart + 1;
		while (end < html.length && html.charAt(end) !== quote) end += 1;
		const raw = html.slice(rawStart + 1, end);
		if (end < html.length) end += 1;
		return { raw, end };
	}
	let end = rawStart;
	while (end < html.length && !isSpace(html.charAt(end)) && html.charAt(end) !== '>') end += 1;
	return { raw: html.slice(rawStart, end), end };
}

function endsName(char: string): boolean {
	return isSpace(char) || char === '=' || char === '>' || char === '/';
}

function attrKind(html: string, start: number, end: number): 'src' | 'srcset' | null {
	if (equalsAscii(html, start, end, 'src')) return 'src';
	if (equalsAscii(html, start, end, 'srcset')) return 'srcset';
	return null;
}

function isHeldValue(kind: 'src' | 'srcset', decoded: string): boolean {
	if (kind === 'srcset') {
		return decoded.split(',').some((part) => isRemote(normalizeImageUrlValue(srcsetCandidateUrl(part))));
	}
	return isRemote(decoded);
}

/** First whitespace-delimited token. Descriptors after that stay descriptors. */
function srcsetCandidateUrl(part: string): string {
	return part.trim().split(/\s+/)[0] ?? '';
}

/** Match URL parsing after HTML decode: drop tab/LF/CR, trim C0 controls and DEL at ends. */
function normalizeImageUrlValue(value: string): string {
	let out = '';
	for (let i = 0; i < value.length; i += 1) {
		const code = value.charCodeAt(i);
		if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
		out += value.charAt(i);
	}
	let start = 0;
	while (start < out.length && isC0OrDel(out.charCodeAt(start))) start += 1;
	let end = out.length;
	while (end > start && isC0OrDel(out.charCodeAt(end - 1))) end -= 1;
	return out.slice(start, end);
}

function isC0OrDel(code: number): boolean {
	return code <= 0x1f || code === 0x7f;
}

function stored(kind: 'src' | 'srcset', raw: string): string {
	if (kind === 'srcset') return prefixProtocolRelativeTokens(raw);
	const trimmed = raw.trim();
	return trimmed.startsWith('//') ? `https:${trimmed}` : raw;
}

function prefixProtocolRelativeTokens(raw: string): string {
	let out = '';
	let start = 0;
	for (let i = 0; i <= raw.length; i += 1) {
		if (i !== raw.length && raw.charAt(i) !== ',') continue;
		out += prefixCandidate(raw.slice(start, i));
		if (i !== raw.length) out += ',';
		start = i + 1;
	}
	return out;
}

function prefixCandidate(part: string): string {
	const rest = part.trimStart();
	const lead = part.length - rest.length;
	if (rest.startsWith('//')) return `${part.slice(0, lead)}https:${rest}`;
	return part;
}

function isRemote(value: string): boolean {
	const trimmed = value.trim();
	return (
		startsWithIgnoreAscii(trimmed, 'http://') ||
		startsWithIgnoreAscii(trimmed, 'https://') ||
		trimmed.startsWith('//')
	);
}

function escapeAttr(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

/**
 * Attribute text the HTML parser would see. Numeric references and named ones
 * such as `&colon;` are decoded before a URL is judged or stored.
 */
function decodeCharacterReferences(value: string): string {
	let out = '';
	for (let i = 0; i < value.length; ) {
		if (value.charAt(i) !== '&') {
			out += value.charAt(i);
			i += 1;
			continue;
		}
		const numeric = matchNumericReference(value, i);
		const named = numeric ? null : matchNamedReference(value, i);
		const match = numeric ?? named;
		if (!match) {
			out += '&';
			i += 1;
			continue;
		}
		out += match.char;
		i = match.next;
	}
	return out;
}

function matchNumericReference(value: string, start: number): { char: string; next: number } | null {
	let i = start + 1;
	if (value.charAt(i) !== '#') return null;
	i += 1;
	const hex = value.charAt(i) === 'x' || value.charAt(i) === 'X';
	if (hex) i += 1;
	const digitsStart = i;
	while (i < value.length && isRefDigit(value.charAt(i), hex)) i += 1;
	if (i === digitsStart) return null;
	const code = Number.parseInt(value.slice(digitsStart, i), hex ? 16 : 10);
	const char = characterFromReference(code);
	if (char == null) return null;
	if (value.charAt(i) === ';') i += 1;
	return { char, next: i };
}

function matchNamedReference(value: string, start: number): { char: string; next: number } | null {
	let end = start + 1;
	const limit = Math.min(value.length, end + 32);
	while (end < limit && isAsciiLetter(value.charAt(end))) end += 1;
	for (let j = end; j > start + 1; j -= 1) {
		const name = value.slice(start + 1, j);
		const char = NAMED_REFERENCES[name];
		if (!char) continue;
		let next = j;
		if (value.charAt(next) === ';') {
			next += 1;
		} else {
			const following = value.charAt(next);
			if (following === '=' || isAsciiAlphaNum(following)) continue;
		}
		return { char, next };
	}
	return null;
}

function characterFromReference(code: number): string | null {
	if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return null;
	if (code === 0 || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
	return String.fromCodePoint(code);
}

function isRefDigit(char: string, hex: boolean): boolean {
	if (char >= '0' && char <= '9') return true;
	if (!hex) return false;
	return (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F');
}

function isAsciiLetter(char: string): boolean {
	return (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z');
}

function isAsciiAlphaNum(char: string): boolean {
	return isAsciiLetter(char) || (char >= '0' && char <= '9');
}

/** Named references that can hide a scheme, a slash, or whitespace around one. */
const NAMED_REFERENCES: Record<string, string> = {
	amp: '&',
	AMP: '&',
	apos: "'",
	ast: '*',
	bsol: '\\',
	circ: '^',
	colon: ':',
	comma: ',',
	commat: '@',
	dollar: '$',
	equals: '=',
	excl: '!',
	grave: '`',
	gt: '>',
	GT: '>',
	hat: '^',
	lbrack: '[',
	lbrace: '{',
	lcub: '{',
	lpar: '(',
	lowbar: '_',
	lsqb: '[',
	lt: '<',
	LT: '<',
	mid: '|',
	midast: '*',
	NewLine: '\n',
	nbsp: '\u00a0',
	num: '#',
	percnt: '%',
	period: '.',
	plus: '+',
	quest: '?',
	quot: '"',
	QUOT: '"',
	rbrack: ']',
	rbrace: '}',
	rcub: '}',
	rpar: ')',
	rsqb: ']',
	semi: ';',
	sol: '/',
	Tab: '\t',
	tilde: '~',
	verbar: '|',
	vert: '|',
	VerticalLine: '|'
};

function equalsAscii(html: string, start: number, end: number, expected: string): boolean {
	if (end - start !== expected.length) return false;
	for (let i = 0; i < expected.length; i += 1) {
		if (asciiLower(html.charCodeAt(start + i)) !== expected.charCodeAt(i)) return false;
	}
	return true;
}

function startsWithIgnoreAscii(value: string, prefix: string): boolean {
	if (value.length < prefix.length) return false;
	for (let i = 0; i < prefix.length; i += 1) {
		if (asciiLower(value.charCodeAt(i)) !== prefix.charCodeAt(i)) return false;
	}
	return true;
}

function asciiLower(code: number): number {
	return code >= 65 && code <= 90 ? code + 32 : code;
}

function isSpace(char: string): boolean {
	return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
}
