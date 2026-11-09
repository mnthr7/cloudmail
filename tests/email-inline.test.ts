import { describe, expect, test } from 'bun:test';
import { shadowEmailCss } from '../src/lib/utils/email-html';
import { sanitizeInlineEmailHtml } from '../src/lib/security/email-html';

describe('shadowEmailCss', () => {
	const css = shadowEmailCss();

	test('aims every document selector at the shadow root', () => {
		const clean = css.replace(/\{[^{}]*\}/g, '{}');
		expect(clean).not.toMatch(/:root\b/);
		expect(clean).not.toMatch(/(^|[\s,(>])(html|body)\b/m);
		expect(css).toContain(":host([data-theme='dark']) .root {");
		expect(css).toContain(":host([data-skin='ledger']) .root {");
		expect(css).toContain(":host(:not([data-theme='dark'])) { color-scheme: light; }");
	});

	test('keeps the quote toggle and table scroller rules', () => {
		expect(css).toContain('.quote-hidden { display: none !important; }');
		expect(css).toContain('.table-scroll');
	});
});

describe('sanitizeInlineEmailHtml', () => {
	test('a Gmail message keeps its words and the classes quote folding needs', () => {
		const out = sanitizeInlineEmailHtml(
			'<div dir="ltr">Hi there,<br>Would your app fit?</div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Sun wrote:</div><blockquote class="gmail_quote" type="cite">old</blockquote></div>'
		);
		expect(out).toContain('Would your app fit?');
		expect(out).toContain('class="gmail_quote"');
		expect(out).toContain('type="cite"');
	});

	test('drops script, handlers, head and title from a whole document', () => {
		const out = sanitizeInlineEmailHtml(
			'<html><head><title>Secret title</title><style>p{color:red}</style></head><body><p onclick="x()">Hello</p><script>alert(1)</script></body></html>'
		);
		expect(out).toBe('<p>Hello</p>');
	});

	test('positioning and url() never survive', () => {
		const out = sanitizeInlineEmailHtml(
			'<div style="position:fixed;top:0;background-image:url(https://t.example/p.gif);color:red">x</div>'
		);
		expect(out).not.toContain('position');
		expect(out).not.toContain('url(');
		expect(out).toContain('color:red');
	});

	test('remote images become placeholders while held', () => {
		const out = sanitizeInlineEmailHtml('<p><img src="https://t.example/p.gif" alt="logo"></p>', {
			remoteImages: false
		});
		expect(out).toBe('<p><span>[image: logo]</span></p>');
	});
});
