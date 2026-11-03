import { describe, expect, test } from 'bun:test';
import { buildEmailDocument, emailCss, isRichHtml } from '../src/lib/utils/email-html';

/** Every selector in a stylesheet string, comments stripped. */
function selectors(css: string): string[] {
	const out: string[] = [];
	const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
	for (const match of clean.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
		for (const selector of match[1].split(',')) {
			const trimmed = selector.trim();
			if (trimmed) out.push(trimmed);
		}
	}
	return out;
}

/** Does the selector's subject (or any compound in it) target this element? */
function targetsElement(selector: string, element: string): boolean {
	return new RegExp(`(^|[\\s>+~(])${element}(?![\\w-])`).test(selector);
}

const LAYOUT_ELEMENTS = ['table', 'td', 'th', 'tr', 'tbody', 'pre', 'code', 'p', 'h1', 'h2', 'ul', 'ol', 'blockquote', 'hr', 'img'];

const DESIGNED_EMAIL = `<!DOCTYPE html><html><head><style>p{margin:0}</style></head>
<body style="margin:0;background:#f0eee6">
<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">
<tr><td align="center"><table width="600" border="0" cellpadding="0" cellspacing="0">
<tr><td style="padding:24px"><h1 style="margin:0">Welcome to the Claude Platform</h1>
<table border="0" cellpadding="0" cellspacing="0"><tr><td><pre style="margin:0">import anthropic</pre></td></tr></table>
</td></tr></table></td></tr></table></body></html>`;

describe('emailCss for designed (rich) mail', () => {
	const css = emailCss(true);

	test('does not style the sender\u2019s layout elements', () => {
		const offending = selectors(css).filter((selector) =>
			LAYOUT_ELEMENTS.some((element) => targetsElement(selector, element))
		);
		expect(offending).toEqual([]);
	});

	test('adds no cell borders or padding and no inherited line-height', () => {
		expect(css).not.toMatch(/border:\s*1px solid rgba\(0, 0, 0, 0\.12\)/);
		expect(css).not.toContain('line-height: 1.65');
		expect(css).not.toContain('overflow-wrap: anywhere');
	});

	test('still lets wide designed mail scroll sideways instead of clipping', () => {
		expect(css).toMatch(/html\s*\{[^}]*overflow-x:\s*auto/);
		expect(css).toContain('.quote-hidden');
		expect(css).toContain('.quote-toggle');
	});

	test('a designed email is detected as rich and kept as its own document', () => {
		expect(isRichHtml(DESIGNED_EMAIL)).toBe(true);
		expect(buildEmailDocument(DESIGNED_EMAIL, { rich: true })).toBe(DESIGNED_EMAIL);
	});

	test('a designed fragment gets only the frame rules', () => {
		const fragment = '<table border="0" cellpadding="0"><tr><td>Hi</td></tr></table>';
		const doc = buildEmailDocument(fragment, { rich: true });
		expect(doc).toContain(fragment);
		expect(doc).not.toMatch(/(^|[\s,}])td\s*[,{]/);
	});
});

describe('emailCss for correspondence and markdown', () => {
	const css = emailCss(false);

	test('only decorates tables markdown generated (inside .table-scroll)', () => {
		for (const selector of selectors(css)) {
			if (['table', 'td', 'th', 'caption'].some((element) => targetsElement(selector, element))) {
				const decorative = /^(?::root\[data-(?:theme|skin)='[a-z]+'\]\s+)?\.table-scroll\b/.test(selector);
				// `table { max-width: 100% }` keeps quoted layout inside the column; it adds no box.
				expect(decorative || selector === 'table').toBe(true);
			}
		}
		expect(css).toMatch(/\.table-scroll th,\s*\.table-scroll td\s*\{[^}]*border:\s*1px solid/);
		expect(css).toMatch(/\.table-scroll th,\s*\.table-scroll td\s*\{[^}]*white-space:\s*nowrap/);
		expect(css).toMatch(/\.table-scroll\s*\{[^}]*overflow-x:\s*auto/);
	});

	test('keeps the reading typography and scrollable code blocks', () => {
		expect(css).toContain('line-height: 1.65');
		expect(css).toMatch(/(^|\n)pre\s*\{[^}]*white-space:\s*pre;/);
		expect(css).toContain('.pre-scroll');
		expect(css).toMatch(/(^|\n)hr\s*\{/);
	});
});
