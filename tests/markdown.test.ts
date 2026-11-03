import { describe, expect, test } from 'bun:test';
import { isMarkdownAttachment } from '../src/lib/utils/attachments';
import { emailCss } from '../src/lib/utils/email-html';
import {
	hasUsefulHtml,
	isTrailingEmailQuote,
	looksLikeMarkdown,
	renderMarkdown,
	resolveMessageBody
} from '../src/lib/utils/markdown';

const FITCHECK_TABLE = `FITCHECK LAUNCH ROADMAP                                              |
+----------------------+--------------------+--------------------+-------------------+--------------------+
| Phase 1: Weeks 1-3   | Phase 2: Weeks 4-5 | Phase 3: Weeks 6-8 | Phase 4: Month 3  | Phase 5: Ongoing   |
| Concierge Beta (15)  | Shopify App Store  | Agency Partner     | Cold Outbound ABM | Search Ads &       |
| Free Setup & Reviews | Listing & ASO      | Rev-Share Program  | Video Loom Audits | Content Marketing  |
+----------------------+--------------------+--------------------+-------------------+--------------------+`;

const SHOPIFY_VTO_MATRIX = `+-------------------------------------------------------------------------------------------------------------+
|                                    SHOPIFY VTO & AI FASHION MATRIX                                          |
+---------------------------+-----------------------+-------------------+-----------------+-------------------+
| App Name & URL            | Est. Active Installs  | Pricing Range     | Est. MRR / ARR  | Primary Focus     |
+---------------------------+-----------------------+-------------------+-----------------+-------------------+
| OnModel                   | ~970 - 1,300 stores   | $9 - $99/mo       | $35K - $50K MRR | Merchant Catalog  |
| apps.shopify.com/model-swap                       | (Free: 25 swaps)  | $420K-$600K ARR | Photo Generator   |
+---------------------------+-----------------------+-------------------+-----------------+-------------------+
| Antla AI Virtual Try On   | ~670 - 750 stores     | $19.99 - $199/mo  | $25K - $35K MRR | Consumer VTO      |
| apps.shopify.com/antla    | (+1470% YoY Growth)   | (7-day trial)     | $300K-$420K ARR | Single-Garment    |
+---------------------------+-----------------------+-------------------+-----------------+-------------------+
| GenLook AI Try On         | ~550 - 620 stores     | Free - $149/mo    | $18K - $25K MRR | Consumer VTO      |
| apps.shopify.com/genlook  |                       |                   | $215K-$300K ARR | Single-Garment    |
+---------------------------+-----------------------+-------------------+-----------------+-------------------+`;

function cellTexts(html: string, tag: 'th' | 'td'): string[] {
	const texts: string[] = [];
	const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'gi');
	for (const match of html.matchAll(pattern)) {
		texts.push(
			match[1]
				.replace(/<br\s*\/?>/gi, '\n')
				.replace(/&amp;/g, '&')
				.replace(/&lt;/g, '<')
				.replace(/&gt;/g, '>')
				.replace(/&quot;/g, '"')
				.trim()
		);
	}
	return texts;
}

describe('hasUsefulHtml', () => {
	test('rejects empty and whitespace', () => {
		expect(hasUsefulHtml(null)).toBe(false);
		expect(hasUsefulHtml('')).toBe(false);
		expect(hasUsefulHtml('   ')).toBe(false);
	});

	test('rejects a <br> conversion of plain text', () => {
		expect(hasUsefulHtml('Hello<br>\nWorld')).toBe(false);
		expect(hasUsefulHtml('<p>Hello</p><p>World</p>')).toBe(false);
		expect(hasUsefulHtml('<pre># heading\n\n- item</pre>')).toBe(false);
	});

	test('keeps designed or richly marked-up mail', () => {
		expect(hasUsefulHtml('<table><tr><td>Invoice</td></tr></table>')).toBe(true);
		expect(hasUsefulHtml('<p>Hello <strong>world</strong></p>')).toBe(true);
		expect(hasUsefulHtml('<p>See <a href="https://example.com">this</a></p>')).toBe(true);
		expect(hasUsefulHtml('<style>.x{color:red}</style><p>Hi</p>')).toBe(true);
	});
});

describe('looksLikeMarkdown', () => {
	test('detects headings, fences, lists and links', () => {
		expect(looksLikeMarkdown('# Release notes\n\nShipped today.')).toBe(true);
		expect(looksLikeMarkdown('```ts\nconst x = 1;\n```')).toBe(true);
		expect(looksLikeMarkdown('- first\n- second\n- third')).toBe(true);
		expect(looksLikeMarkdown('1. one\n2. two')).toBe(true);
		expect(looksLikeMarkdown('See the [docs](https://example.com/docs).')).toBe(true);
		expect(looksLikeMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |')).toBe(true);
		expect(looksLikeMarkdown(FITCHECK_TABLE)).toBe(true);
	});

	test('does not treat ordinary correspondence as markdown', () => {
		expect(looksLikeMarkdown('Hi,\n\nCan you look at this?\n\nThanks')).toBe(false);
		expect(looksLikeMarkdown('1. please review the attached invoice')).toBe(false);
		expect(looksLikeMarkdown('See https://example.com for details')).toBe(false);
		expect(looksLikeMarkdown('')).toBe(false);
	});
});

describe('isTrailingEmailQuote', () => {
	test('accepts a reply quote that runs to the end', () => {
		expect(
			isTrailingEmailQuote('On Tue, Jane wrote:\n> hello\n> original message')
		).toBe(true);
		expect(isTrailingEmailQuote('> quoted only\n> still quoted')).toBe(true);
	});

	test('rejects a mid-body citation followed by more of the author', () => {
		expect(isTrailingEmailQuote('> a short citation\n\nAnd my conclusion.')).toBe(false);
	});
});

describe('renderMarkdown', () => {
	test('renders headings, lists, emphasis, fences, links and tables', () => {
		const html = renderMarkdown(`# Hello

A **bold** and *italic* word.

- one
- two

\`\`\`js
console.log(1)
\`\`\`

See [docs](https://example.com).

| a | b |
| --- | --- |
| 1 | 2 |
`);

		expect(html).toContain('<h1>');
		expect(html).toContain('<ul>');
		expect(html).toContain('<strong>');
		expect(html).toContain('<em>');
		expect(html).toContain('<pre>');
		expect(html).toContain('<table>');
		expect(html).toContain('href="https://example.com"');
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noopener noreferrer"');
	});

	test('strips scripts and javascript URLs', () => {
		const html = renderMarkdown(`Hello

<script>alert(1)</script>

[xss](javascript:alert(1))
`);

		expect(html.toLowerCase()).not.toContain('<script');
		expect(html.toLowerCase()).not.toContain('javascript:');
		expect(html.toLowerCase()).not.toContain('alert(1)');
	});

	test('turns a decorative ==== rule into an hr without a Setext heading', () => {
		const html = renderMarkdown(`Below is an overview of the key segments and agency partner playbooks.
======================================================================
**EXECUTIVE SUMMARY OF DIRECTORY**
`);

		expect(html).toContain('<hr');
		expect(html).toContain('Below is an overview of the key segments and agency partner playbooks.');
		expect(html).not.toMatch(/<h1[\s>]/);
		expect(html).toContain('<strong>EXECUTIVE SUMMARY OF DIRECTORY</strong>');
		expect(html).not.toContain('====');
	});

	test('collapses a wrapped leftover ===== line into one hr', () => {
		const html = renderMarkdown(`Overview of the segments.
======================================================================
=====
# Title
`);

		expect(html).toContain('<hr');
		expect(html.match(/<hr/g)?.length).toBe(1);
		expect(html).toContain('<h1>');
		expect(html).toContain('Title');
		expect(html).not.toContain('====');
	});

	test('leaves ==== inside a real code fence and keeps --- hrs', () => {
		const html = renderMarkdown(`# Notes

---

\`\`\`
====
not a rule
\`\`\`
`);

		expect(html).toContain('<h1>');
		expect(html).toContain('<hr');
		expect(html).toContain('<pre>');
		expect(html).toContain('====');
		expect(html).toContain('not a rule');
	});

	test('converts a fenced FITCHECK ASCII box table into a scrollable HTML table', () => {
		const html = renderMarkdown(`## 5. Comprehensive Launch Strategy & Playbook

\`\`\`
${FITCHECK_TABLE}
\`\`\`
`);

		expect(html).toContain('<h2>');
		expect(html).toContain('class="table-scroll"');
		expect(html).toContain('<table>');
		expect(html).toContain('<caption>FITCHECK LAUNCH ROADMAP</caption>');
		expect(html).toContain('<th>Phase 1: Weeks 1-3</th>');
		expect(html).toContain('<th>Phase 5: Ongoing</th>');
		expect(html).toContain('<td>Concierge Beta (15)</td>');
		expect(html).toContain('<td>Content Marketing</td>');
		expect(html).not.toContain('<pre>');
		expect(html).not.toContain('+----------------------+');
	});

	test('converts an unfenced ASCII box table the same way', () => {
		const html = renderMarkdown(`Notes\n\n${FITCHECK_TABLE}\n`);
		expect(html).toContain('<caption>FITCHECK LAUNCH ROADMAP</caption>');
		expect(html).toContain('<th>Phase 2: Weeks 4-5</th>');
		expect(html).toContain('class="table-scroll"');
		expect(html).not.toContain('<pre>');
	});

	test('keeps a real JavaScript fence as preformatted code', () => {
		const html = renderMarkdown(`# Example

\`\`\`js
function add(a, b) {
  return a + b;
}
console.log(add(1, 2));
\`\`\`
`);

		expect(html).toContain('<pre>');
		expect(html).toContain('class="pre-scroll"');
		expect(html).toContain('console.log');
		expect(html).toContain('function add');
		expect(html).not.toContain('<table>');
		expect(html).not.toContain('class="table-scroll"');
	});

	test('still renders pipe markdown tables as HTML tables', () => {
		const html = renderMarkdown(`| a | b |\n| --- | --- |\n| 1 | 2 |\n`);
		expect(html).toContain('<table>');
		expect(html).toContain('<th>');
		expect(html).toContain('class="table-scroll"');
		expect(html).toContain('>1</td>');
	});

	test('converts a fenced Shopify VTO banner matrix into a scrollable HTML table', () => {
		const html = renderMarkdown(`## Competitor research\n\n\`\`\`\n${SHOPIFY_VTO_MATRIX}\n\`\`\`\n`);

		expect(html).toContain('class="table-scroll"');
		expect(html).toContain('<table>');
		expect(html).toContain('<caption>SHOPIFY VTO &amp; AI FASHION MATRIX</caption>');
		expect(html).not.toContain('<pre>');
		expect(html).not.toContain('+---------------------------+');

		const headers = cellTexts(html, 'th');
		expect(headers).toEqual([
			'App Name & URL',
			'Est. Active Installs',
			'Pricing Range',
			'Est. MRR / ARR',
			'Primary Focus'
		]);

		const cells = cellTexts(html, 'td');
		expect(cells).toHaveLength(15);

		expect(cells[0]).toContain('OnModel');
		expect(cells[0]).toContain('apps.shopify.com/model-swap');
		expect(cells[1]).toBe('~970 - 1,300 stores');
		expect(cells[2]).toContain('$9 - $99/mo');
		expect(cells[2]).toContain('(Free: 25 swaps)');
		expect(cells[2]).not.toContain('970');
		expect(cells[3]).toContain('$35K - $50K MRR');
		expect(cells[3]).toContain('$420K-$600K ARR');
		expect(cells[4]).toContain('Merchant Catalog');
		expect(cells[4]).toContain('Photo Generator');

		expect(cells[5]).toContain('Antla AI Virtual Try On');
		expect(cells[5]).toContain('apps.shopify.com/antla');
		expect(cells[6]).toContain('~670 - 750 stores');
		expect(cells[6]).toContain('(+1470% YoY Growth)');
		expect(cells[7]).toContain('$19.99 - $199/mo');
		expect(cells[7]).toContain('(7-day trial)');
		expect(cells[8]).toContain('$25K - $35K MRR');
		expect(cells[8]).toContain('$300K-$420K ARR');
		expect(cells[9]).toContain('Consumer VTO');
		expect(cells[9]).toContain('Single-Garment');

		expect(cells[10]).toContain('GenLook AI Try On');
		expect(cells[10]).toContain('apps.shopify.com/genlook');
		expect(cells[11]).toBe('~550 - 620 stores');
		expect(cells[12]).toBe('Free - $149/mo');
		expect(cells[13]).toContain('$18K - $25K MRR');
		expect(cells[13]).toContain('$215K-$300K ARR');
		expect(cells[14]).toContain('Consumer VTO');
		expect(cells[14]).toContain('Single-Garment');
	});

	test('converts an unfenced Shopify VTO matrix the same way', () => {
		const html = renderMarkdown(`Notes\n\n${SHOPIFY_VTO_MATRIX}\n`);
		expect(html).toContain('<caption>SHOPIFY VTO &amp; AI FASHION MATRIX</caption>');
		expect(html).toContain('class="table-scroll"');
		expect(html).not.toContain('<pre>');
		expect(cellTexts(html, 'td')[0]).toContain('apps.shopify.com/model-swap');
	});
});

describe('emailCss', () => {
	test('does not wrap leftover pre blocks, and makes tables scroll sideways', () => {
		const css = emailCss(false);
		expect(css).toContain('white-space: pre;');
		expect(css).not.toMatch(/pre\s*\{[^}]*white-space:\s*pre-wrap/);
		expect(css).toContain('.table-scroll');
		expect(css).toContain('.pre-scroll');
		expect(css).toContain('-webkit-overflow-scrolling: touch');
		expect(css).toContain('overflow-x: auto');
	});
});

describe('resolveMessageBody', () => {
	test('prefers useful HTML over markdown-looking text', () => {
		const display = resolveMessageBody({
			body_html: '<p>Designed <strong>mail</strong></p>',
			body_text: '# This looks like markdown\n\n- item'
		});
		expect(display.kind).toBe('html');
		if (display.kind === 'html') {
			expect(display.html).toContain('<strong>');
		}
	});

	test('renders markdown when the HTML is only a <br> wrap', () => {
		const text = '# Hello\n\n- one\n- two\n\n```\ncode\n```';
		const display = resolveMessageBody({
			body_html: text.replaceAll('\n', '<br>\n'),
			body_text: text
		});
		expect(display.kind).toBe('markdown');
		if (display.kind === 'markdown') {
			expect(display.html).toContain('<h1>');
			expect(display.html).toContain('<ul>');
			expect(display.quoted).toBe('');
		}
	});

	test('keeps trailing reply quotes out of the markdown parse', () => {
		const display = resolveMessageBody({
			body_html: null,
			body_text: '# Update\n\n- shipped\n\nOn Tue, Jane wrote:\n> old message'
		});
		expect(display.kind).toBe('markdown');
		if (display.kind === 'markdown') {
			expect(display.html).toContain('<h1>');
			expect(display.quoted).toContain('old message');
			expect(display.html).not.toContain('old message');
		}
	});

	test('renders a FITCHECK roadmap email as markdown tables, not pre', () => {
		const text = `## 5. Comprehensive Launch Strategy & Playbook\n\n\`\`\`\n${FITCHECK_TABLE}\n\`\`\`\n`;
		const display = resolveMessageBody({
			body_html: `<pre>${text}</pre>`,
			body_text: text
		});
		expect(display.kind).toBe('markdown');
		if (display.kind === 'markdown') {
			expect(display.html).toContain('<th>Phase 1: Weeks 1-3</th>');
			expect(display.html).toContain('class="table-scroll"');
			expect(display.html).not.toContain('<pre>');
		}
	});

	test('renders a text-only Shopify VTO email as a markdown table', () => {
		const text = `\`\`\`\n${SHOPIFY_VTO_MATRIX}\n\`\`\`\n`;
		const display = resolveMessageBody({
			body_html: null,
			body_text: text
		});
		expect(display.kind).toBe('markdown');
		if (display.kind === 'markdown') {
			expect(display.html).toContain('<caption>SHOPIFY VTO &amp; AI FASHION MATRIX</caption>');
			expect(display.html).toContain('class="table-scroll"');
			expect(display.html).not.toContain('<pre>');
			expect(cellTexts(display.html, 'th')).toContain('App Name & URL');
		}
	});

	test('falls back to plain text when nothing looks like markdown', () => {
		const display = resolveMessageBody({
			body_html: 'Just a line<br>\nAnd another',
			body_text: 'Just a line\nAnd another'
		});
		expect(display).toEqual({
			kind: 'text',
			body: 'Just a line\nAnd another',
			quoted: ''
		});
	});
});

describe('isMarkdownAttachment', () => {
	test('detects markdown attachments by name or type', () => {
		expect(isMarkdownAttachment({ filename: 'notes.md', content_type: 'application/octet-stream' })).toBe(
			true
		);
		expect(isMarkdownAttachment({ filename: 'README.markdown', content_type: 'text/plain' })).toBe(true);
		expect(isMarkdownAttachment({ filename: 'doc.txt', content_type: 'text/markdown' })).toBe(true);
		expect(isMarkdownAttachment({ filename: 'invoice.pdf', content_type: 'application/pdf' })).toBe(false);
	});
});

import { hasVisibleHtml as _hv, resolveMessageBody as _rb } from '../src/lib/utils/markdown';

describe('hasVisibleHtml (blank HTML parts)', () => {
	test('style + empty divs + tracking pixel is not visible', () => {
		const html =
			'<html><head><style>p{color:red}</style></head><body><div style="display:none">&nbsp;</div><img src="https://t.example/p.gif" width="1" height="1"></body></html>';
		expect(_hv(html)).toBe(false);
	});
	test('words, or a real image, are visible', () => {
		expect(_hv('<div><p>Hello</p></div>')).toBe(true);
		expect(_hv('<table><tr><td><img src="https://x/y.png" width="600"></td></tr></table>')).toBe(true);
	});
	test('HTML with nothing to see falls back to the text part', () => {
		const out = _rb({
			body_html: '<html><body><table><tr><td>&nbsp;</td></tr></table></body></html>',
			body_text: 'Thanks for requesting a trial. Your key is ABC.'
		});
		expect(out.kind).toBe('text');
	});
	test('real HTML still wins over text', () => {
		const out = _rb({ body_html: '<table><tr><td>Hi there</td></tr></table>', body_text: 'Hi there' });
		expect(out.kind).toBe('html');
	});
});
