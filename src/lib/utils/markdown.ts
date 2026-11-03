/**
 * Detecting and rendering markdown that arrived as text/plain.
 *
 * Designed HTML mail already has a path — EmailBody + isRichHtml. This module
 * is only for the other case: a text part that was written as markdown, or a
 * .md attachment. The HTML part, when it is a real document, always wins.
 */

import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { splitQuotedText } from './quotes';

/** Tags mail clients add when they wrap a text body. Not a designed message. */
const TRIVIAL_HTML = /<\/?(?:br|p|div|span|pre|html|head|body|meta|link)(?:\s[^>]*)?\/?>/gi;

/**
 * True when the HTML part is a real document, not a line-break conversion of
 * the text. Designed mail, and ordinary rich replies with <strong>/<a>/<ul>,
 * must stay on the existing HTML path.
 */
export function hasUsefulHtml(html: string | null | undefined): boolean {
	if (!html || !html.trim()) return false;

	const leftover = html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<!doctype[^>]*>/gi, '')
		.replace(TRIVIAL_HTML, '')
		.trim();

	return /<[a-z][\s\S]*?>/i.test(leftover);
}

/**
 * Does the HTML part show anything at all? Some senders ship an HTML part that
 * is only a stylesheet, a tracking pixel or a hidden preheader, with the real
 * words in the text part. That passes hasUsefulHtml (it has tags) and then
 * renders as a blank page.
 */
export function hasVisibleHtml(html: string | null | undefined): boolean {
	if (!html || !html.trim()) return false;

	const body = html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<(head|style|script|title|template|noscript)[\s>][\s\S]*?<\/\1\s*>/gi, '');

	const text = body
		.replace(/<[^>]*>/g, ' ')
		.replace(/&(nbsp|zwnj|zwj|shy|#8203|#x200b|#160|#xa0|#847|#x34f);?/gi, ' ')
		.replace(/[\s\u00a0\u200b-\u200f\u2060\u034f\ufeff\u00ad]+/g, '');
	if (text.length > 0) return true;

	// No words — an image, video or embed may still be the whole message.
	for (const match of body.matchAll(/<(img|video|svg|canvas|iframe|object|embed|picture)\b[^>]*>/gi)) {
		const tag = match[0];
		if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(tag)) continue;
		if (/\b(width|height)\s*=\s*["']?[01]["']?(?=[\s/>"'])/i.test(tag)) continue; // tracking pixel
		if (/\b(width|height)\s*:\s*[01]px/i.test(tag)) continue;
		return true;
	}
	return false;
}

/**
 * Cheap heuristic: fences, headings, markdown links and tables are enough on
 * their own; lists and emphasis need a second signal so "1. please review"
 * does not become a formatted list.
 */
export function looksLikeMarkdown(text: string): boolean {
	const source = text.trim();
	if (!source) return false;

	let score = 0;

	if (/```[\s\S]*?```/.test(source) || /~~~[\s\S]*?~~~/.test(source)) score += 2;
	if (/^#{1,6}\s+\S/m.test(source)) score += 2;
	if (/\[[^\]]+\]\([^)\s]+\)/.test(source)) score += 2;
	if (/^\|.+\|.+\|$/m.test(source) && /^\s*\|?[\s:\-|]+$/m.test(source)) score += 2;

	const unordered = source.match(/^\s*[-*+]\s+\S/gm);
	if (unordered && unordered.length >= 2) score += 2;
	else if (unordered?.length === 1) score += 1;

	const ordered = source.match(/^\s*\d+\.\s+\S/gm);
	if (ordered && ordered.length >= 2) score += 2;
	else if (ordered?.length === 1) score += 1;

	if (/^>\s+\S/m.test(source)) score += 1;
	if (/(\*\*|__)[^*\n]+?\1/.test(source)) score += 1;
	if (/`[^`\n]+`/.test(source)) score += 1;
	if (hasAsciiBoxTable(source)) score += 2;

	return score >= 2;
}

/**
 * Quoted history at the end of a reply is folded; a markdown blockquote in
 * the middle of the author's own words is not. splitQuotedText treats the
 * first ">" as the cut, so a mid-body citation would steal the rest of the
 * message — only keep that cut when the remainder looks like mail quoting.
 */
export function isTrailingEmailQuote(quoted: string): boolean {
	if (!quoted.trim()) return false;

	return quoted.split(/\r?\n/).every((line) => {
		const trimmed = line.trim();
		return (
			!trimmed ||
			trimmed.startsWith('>') ||
			/^\s*on\b/i.test(trimmed) ||
			/wrote:\s*$/i.test(trimmed) ||
			/original message/i.test(trimmed) ||
			/forwarded message/i.test(trimmed) ||
			/^[-_]{3,}$/.test(trimmed)
		);
	});
}

const SANITIZE: sanitizeHtml.IOptions = {
	allowedTags: [
		'p',
		'br',
		'hr',
		'h1',
		'h2',
		'h3',
		'h4',
		'h5',
		'h6',
		'ul',
		'ol',
		'li',
		'strong',
		'em',
		'b',
		'i',
		'del',
		's',
		'a',
		'img',
		'blockquote',
		'pre',
		'code',
		'table',
		'thead',
		'tbody',
		'tr',
		'th',
		'td',
		'caption'
	],
	allowedAttributes: {
		a: ['href', 'title', 'target', 'rel'],
		img: ['src', 'alt', 'title'],
		code: ['class'],
		th: ['align'],
		td: ['align']
	},
	allowedSchemes: ['http', 'https', 'mailto'],
	allowedSchemesByTag: {
		img: ['http', 'https']
	},
	allowProtocolRelative: false,
	// We never keep style="" — skip PostCSS so this stays Workers-safe.
	parseStyleAttributes: false,
	// marked leaves language-* on fenced blocks; keep those, drop everything else.
	allowedClasses: {
		code: [/^language-/]
	},
	transformTags: {
		a: (_tagName, attribs) => ({
			tagName: 'a',
			attribs: {
				...attribs,
				target: '_blank',
				rel: 'noopener noreferrer'
			}
		})
	}
};

const TABLE_TOKEN = /@@QM_ASCII_TABLE_(\d+)@@/g;

/** `+----+----+` or a single-span banner `+----...----+`. */
function isBoxBorder(line: string): boolean {
	return /^\+(?:[-=]+\+)+$/.test(line.trim());
}

function borderColumnCount(line: string): number {
	return Math.max(0, borderStops(line).length - 1);
}

function borderStops(line: string): number[] {
	const stops: number[] = [];
	for (let index = 0; index < line.length; index += 1) {
		if (line[index] === '+') stops.push(index);
	}
	return stops;
}

/** `| cell | cell |` — at least two cells. */
function isBoxRow(line: string): boolean {
	const trimmed = line.trim();
	if (!isBoxContentLine(trimmed)) return false;
	return parseBoxRow(trimmed).length >= 2;
}

/** Any `| ... |` row, including a 1-cell banner title. */
function isBoxContentLine(line: string): boolean {
	const trimmed = line.trim();
	return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length >= 2;
}

function parseBoxRow(line: string): string[] {
	let body = line.trim();
	if (body.startsWith('|')) body = body.slice(1);
	if (body.endsWith('|')) body = body.slice(0, -1);
	return body.split('|').map((cell) => cell.trim());
}

/**
 * Visual columns follow the `+` positions on the multi-column border.
 * A wrap line that drops a pipe has fewer `|` cells than columns — keep the
 * first cell on the left (name / URL overflow) and right-align the rest so
 * pricing does not slide into the installs column.
 */
function parseAlignedRow(line: string, columnCount: number, stops: number[]): string[] {
	const byStops = parseRowByStops(line, columnCount, stops);
	const byPipes = parseBoxRow(line);
	if (byPipes.length === columnCount) return byPipes;
	if (byPipes.length > columnCount) return byPipes.slice(0, columnCount);
	if (byPipes.length === 0) return Array.from({ length: columnCount }, () => '');

	const aligned = Array.from({ length: columnCount }, () => '');
	aligned[0] = byPipes[0];
	const tail = byPipes.slice(1);
	const tailStart = columnCount - tail.length;
	for (let index = 0; index < tail.length; index += 1) {
		aligned[tailStart + index] = tail[index];
	}

	// Prefer the alignment that keeps more cells in their visual columns
	// when the border positions also produced a full-width row.
	if (byStops.filter(Boolean).length > aligned.filter(Boolean).length) return byStops;
	return aligned;
}

function parseRowByStops(line: string, columnCount: number, stops: number[]): string[] {
	if (stops.length < 2) return parseBoxRow(line);

	const last = stops[stops.length - 1];
	const padded = line.length < last ? line + ' '.repeat(last - line.length) : line;
	const cells: string[] = [];
	for (let index = 0; index < stops.length - 1 && cells.length < columnCount; index += 1) {
		let slice = padded.slice(stops[index] + 1, stops[index + 1]);
		slice = slice.replace(/^\|/, '').replace(/\|$/, '');
		cells.push(slice.trim());
	}
	while (cells.length < columnCount) cells.push('');
	return mergeOverflowedCells(cells);
}

function mergeOverflowedCells(cells: string[]): string[] {
	const next = cells.slice();
	for (let index = 1; index < next.length; index += 1) {
		const prev = next[index - 1];
		const current = next[index];
		if (!prev || !current) continue;
		if (/\s$/.test(prev) || /^\s/.test(current)) continue;
		if (!/[\w./-]$/.test(prev) || !/^[\w./-]/.test(current)) continue;
		next[index - 1] = `${prev}${current}`;
		next[index] = '';
	}
	return next;
}

function looksLikeCaption(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed || isBoxBorder(trimmed) || isBoxRow(trimmed)) return false;
	if (/^#{1,6}\s/.test(trimmed)) return false;
	if (/^(`{3,}|~{3,})/.test(trimmed)) return false;
	if (/^>\s/.test(trimmed)) return false;
	if (/^(\s*[-*+]|\s*\d+\.)\s+\S/.test(trimmed)) return false;
	return true;
}

function cleanCaption(line: string): string {
	return line.replace(/^\|/, '').replace(/\|\s*$/, '').replace(/\s+/g, ' ').trim();
}

function looksLikePath(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed) return false;
	if (/^https?:\/\//i.test(trimmed)) return true;
	return /^[\w.-]+\.[a-z]{2,}(\/[\w./-]*)?$/i.test(trimmed);
}

function isWrapContinuation(line: string, cells: string[], columnCount: number, previous: string[]): boolean {
	if (parseBoxRow(line).length < columnCount) return true;
	if (!(cells[0] ?? '').trim() && cells.slice(1).some((cell) => cell.trim())) return true;
	const first = cells[0] ?? '';
	const previousFirst = previous[0] ?? '';
	return Boolean(looksLikePath(first) && previousFirst && !looksLikePath(previousFirst));
}

function mergeCellRows(rows: string[][]): string[] {
	if (rows.length === 0) return [];
	const columns = Math.max(...rows.map((row) => row.length));
	const merged = Array.from({ length: columns }, () => '');
	for (const row of rows) {
		for (let index = 0; index < columns; index += 1) {
			const piece = (row[index] ?? '').trim();
			if (!piece) continue;
			if (!merged[index]) merged[index] = piece;
			else if (!merged[index].includes(piece)) merged[index] = `${merged[index]}\n${piece}`;
		}
	}
	return merged;
}

function hasAsciiBoxTable(source: string): boolean {
	const lines = source.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		if (readAsciiBoxTable(lines, index)) return true;
	}
	return false;
}

function firstRowLooksLikeHeader(rows: string[][]): boolean {
	if (rows.length === 0) return false;
	if (rows.length === 1) return true;
	return rows[0].every((cell) => {
		const trimmed = cell.trim();
		if (!trimmed) return true;
		if (trimmed.length > 60) return false;
		return !/[.!?]$/.test(trimmed);
	});
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function asciiTableHtml(caption: string | null, rows: string[][], header: boolean): string {
	const columns = Math.max(...rows.map((row) => row.length), 0);
	const normalized = rows.map((row) => {
		const next = row.slice(0, columns);
		while (next.length < columns) next.push('');
		return next;
	});

	const renderCells = (cells: string[], tag: 'th' | 'td') =>
		`<tr>${cells
			.map((cell) => `<${tag}>${escapeHtml(cell).replace(/\n/g, '<br>')}</${tag}>`)
			.join('')}</tr>`;

	const captionHtml = caption ? `<caption>${escapeHtml(caption)}</caption>` : '';
	const head = header
		? `<thead>${renderCells(normalized[0], 'th')}</thead><tbody>${normalized
				.slice(1)
				.map((row) => renderCells(row, 'td'))
				.join('')}</tbody>`
		: `<tbody>${normalized.map((row) => renderCells(row, 'td')).join('')}</tbody>`;

	return `<table>${captionHtml}${head}</table>`;
}

type AsciiTableMatch = {
	end: number;
	html: string;
};

/** A box table starting at `start`, optionally with a title line above the first border. */
function readAsciiBoxTable(lines: string[], start: number): AsciiTableMatch | null {
	if (start >= lines.length) return null;

	let index = start;
	let caption: string | null = null;

	if (!isBoxBorder(lines[index])) {
		if (
			looksLikeCaption(lines[index]) &&
			index + 1 < lines.length &&
			isBoxBorder(lines[index + 1])
		) {
			caption = cleanCaption(lines[index]);
			index += 1;
		} else {
			return null;
		}
	}

	// Single-span banner + 1-cell title sitting above the real grid.
	if (isBoxBorder(lines[index]) && borderColumnCount(lines[index]) === 1) {
		const titleLine = lines[index + 1];
		const nextBorder = lines[index + 2];
		if (
			titleLine &&
			isBoxContentLine(titleLine) &&
			parseBoxRow(titleLine).length === 1 &&
			nextBorder &&
			isBoxBorder(nextBorder) &&
			borderColumnCount(nextBorder) >= 2
		) {
			caption = cleanCaption(titleLine);
			index += 2;
		}
	}

	if (!isBoxBorder(lines[index]) || borderColumnCount(lines[index]) < 2) return null;

	const stops = borderStops(lines[index]);
	const columnCount = Math.max(0, stops.length - 1);
	type Physical = { line: string; cells: string[] };
	const groups: Physical[][] = [];
	let group: Physical[] = [];
	let sawContent = false;
	let sawInteriorSeparator = false;
	index += 1;

	const pushGroup = () => {
		if (group.length === 0) return;
		groups.push(group);
		group = [];
	};

	while (index < lines.length) {
		if (isBoxBorder(lines[index])) {
			pushGroup();
			index += 1;
			const moreContent = index < lines.length && isBoxContentLine(lines[index]);
			if (sawContent && moreContent) sawInteriorSeparator = true;
			if (!moreContent) break;
			continue;
		}
		if (isBoxContentLine(lines[index])) {
			sawContent = true;
			group.push({
				line: lines[index],
				cells: parseAlignedRow(lines[index], columnCount, stops)
			});
			index += 1;
			continue;
		}
		break;
	}
	pushGroup();

	const rows: string[][] = [];
	for (const physical of groups) {
		if (!sawInteriorSeparator) {
			for (const item of physical) rows.push(item.cells);
			continue;
		}

		let current: string[] | null = null;
		for (const item of physical) {
			if (current && isWrapContinuation(item.line, item.cells, columnCount, current)) {
				current = mergeCellRows([current, item.cells]);
			} else {
				if (current) rows.push(current);
				current = item.cells.slice();
			}
		}
		if (current) rows.push(current);
	}

	if (rows.length === 0 || rows.every((row) => row.filter(Boolean).length < 2)) return null;

	const header = sawInteriorSeparator || firstRowLooksLikeHeader(rows);
	return { end: index, html: asciiTableHtml(caption, rows, header) };
}

function tableFromExclusiveLines(lines: string[]): string | null {
	let start = 0;
	let end = lines.length;
	while (start < end && !lines[start].trim()) start += 1;
	while (end > start && !lines[end - 1].trim()) end -= 1;
	if (start >= end) return null;

	const slice = lines.slice(start, end);
	const match = readAsciiBoxTable(slice, 0);
	if (!match || match.end < slice.length) return null;
	return match.html;
}

function decodeEntities(value: string): string {
	return value
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, '&');
}

function fenceOpen(line: string): { marker: string } | null {
	const match = /^(```+|~~~+)/.exec(line);
	if (!match) return null;
	return { marker: match[1] };
}

function fenceClose(line: string, marker: string): boolean {
	const trimmed = line.trim();
	const character = marker[0] === '`' ? '`' : '~';
	return new RegExp(`^${character}{${marker.length},}\\s*$`).test(trimmed);
}

function liftAsciiBoxTables(source: string, replace: (html: string) => string): string {
	const lines = source.split(/\r?\n/);
	const out: string[] = [];
	let index = 0;

	while (index < lines.length) {
		const open = fenceOpen(lines[index]);
		if (open) {
			const body: string[] = [];
			let cursor = index + 1;
			while (cursor < lines.length && !fenceClose(lines[cursor], open.marker)) {
				body.push(lines[cursor]);
				cursor += 1;
			}
			const closed = cursor < lines.length;
			const table = closed ? tableFromExclusiveLines(body) : null;
			if (table) {
				out.push(replace(table));
				index = cursor + 1;
				continue;
			}
			out.push(...lines.slice(index, closed ? cursor + 1 : lines.length));
			index = closed ? cursor + 1 : lines.length;
			continue;
		}

		const table = readAsciiBoxTable(lines, index);
		if (table) {
			out.push(replace(table.html));
			index = table.end;
			continue;
		}

		out.push(lines[index]);
		index += 1;
	}

	return out.join('\n');
}

function replaceTableTokens(html: string, tables: string[]): string {
	return html
		.replace(/<p>\s*@@QM_ASCII_TABLE_(\d+)@@\s*<\/p>/g, (_, index) => tables[Number(index)] ?? '')
		.replace(TABLE_TOKEN, (_, index) => tables[Number(index)] ?? '');
}

/** Fences we missed (or indented pre) still become tables when they are a box grid. */
function promotePreAsciiTables(html: string): string {
	return html.replace(
		/<pre(?:\s[^>]*)?>(?:<code(?:\s[^>]*)?>)?([\s\S]*?)(?:<\/code>)?<\/pre>/gi,
		(full, inner: string) => {
			const text = decodeEntities(inner).replace(/\n$/, '');
			return tableFromExclusiveLines(text.split('\n')) ?? full;
		}
	);
}

function wrapTables(html: string): string {
	return html.replace(/<table\b[\s\S]*?<\/table>/gi, (table) => {
		if (table.includes('table-scroll')) return table;
		return `<div class="table-scroll">${table}</div>`;
	});
}

function wrapLeftoverPre(html: string): string {
	return html.replace(/<pre\b[\s\S]*?<\/pre>/gi, (pre) => {
		if (pre.includes('pre-scroll')) return pre;
		return `<div class="pre-scroll">${pre}</div>`;
	});
}

const EQUALS_RULE = /^[ \t]*={3,}[ \t]*$/;

/**
 * marked treats `---` / `***` / `___` as `<hr>`, but a line of `====` is a
 * Setext H1 underline — or, with `breaks: true`, leftover raw equals. Outreach
 * mail uses those lines as decorative section rules sitting *above* a heading.
 */
function convertEqualsSectionRules(source: string): string {
	const lines = source.split(/\r?\n/);
	const out: string[] = [];
	let inFence = false;
	let fenceMark = '';

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const trimmedStart = line.trimStart();
		const fence = /^(```|~~~)/.exec(trimmedStart);
		if (fence) {
			if (!inFence) {
				inFence = true;
				fenceMark = fence[1];
			} else if (trimmedStart.startsWith(fenceMark)) {
				inFence = false;
				fenceMark = '';
			}
			out.push(line);
			continue;
		}

		if (!inFence && EQUALS_RULE.test(line)) {
			while (index + 1 < lines.length && EQUALS_RULE.test(lines[index + 1])) {
				index += 1;
			}
			if (out.at(-1)) out.push('');
			out.push('---');
			if (lines[index + 1]) out.push('');
			continue;
		}

		out.push(line);
	}

	return out.join('\n');
}

/**
 * ASCII box tables (`+---+` / `| cell | cell |`) become semantic HTML so
 * they can scroll on a phone instead of wrapping inside a monospaced <pre>.
 * Real code fences are left alone.
 */
export function renderMarkdown(source: string): string {
	const tables: string[] = [];
	const lifted = liftAsciiBoxTables(source, (html) => {
		const token = `@@QM_ASCII_TABLE_${tables.length}@@`;
		tables.push(html);
		return `\n\n${token}\n\n`;
	});

	const raw = marked.parse(convertEqualsSectionRules(lifted), {
		async: false,
		gfm: true,
		breaks: true
	});
	const clean = sanitizeHtml(typeof raw === 'string' ? raw : String(raw), SANITIZE);
	const withAscii = promotePreAsciiTables(replaceTableTokens(clean, tables));
	return wrapLeftoverPre(wrapTables(withAscii));
}

export type MessageBodyDisplay =
	| { kind: 'html'; html: string }
	| { kind: 'markdown'; html: string; quoted: string }
	| { kind: 'text'; body: string; quoted: string }
	| { kind: 'empty' };

/**
 * Pick the display path for a thread message. HTML that is more than a
 * <br>-wrap of the text always wins, even when the text part looks like
 * markdown — that is how designed mail stays designed.
 */
export function resolveMessageBody(message: {
	body_html: string | null;
	body_text: string | null;
}): MessageBodyDisplay {
	if (hasUsefulHtml(message.body_html)) {
		const hasText = Boolean(message.body_text?.trim());
		// An HTML part with nothing to see falls back to the text part, if any.
		if (hasVisibleHtml(message.body_html) || !hasText) {
			return { kind: 'html', html: message.body_html ?? '' };
		}
	}

	const split = splitQuotedText(message.body_text ?? '');
	const trailing = isTrailingEmailQuote(split.quoted);
	const markdownSource = trailing ? split.body : (message.body_text ?? '').trim();
	const quoted = trailing ? split.quoted : '';

	if (markdownSource && looksLikeMarkdown(markdownSource)) {
		return { kind: 'markdown', html: renderMarkdown(markdownSource), quoted };
	}

	if (split.body) {
		return { kind: 'text', body: split.body, quoted: split.quoted };
	}

	return { kind: 'empty' };
}
