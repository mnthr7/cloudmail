import { describe, expect, test } from 'bun:test';
import { quoteHtml } from '../src/lib/writing/quote';

const when = new Date('2026-10-31T23:41:00Z');

describe('quoteHtml', () => {
	test('reply attribution uses local time and the display name', () => {
		const html = quoteHtml({
			kind: 'reply',
			from: 'Ada Lovelace <ada@example.com>',
			to: 'me@cloudmail.test',
			subject: 'Hello',
			createdAt: when.toISOString(),
			html: '<p>Body</p>',
			text: null,
			timeZone: 'UTC'
		});
		expect(html).toContain('On Sat, Oct 31, 2026 at 11:41 PM, Ada Lovelace &lt;ada@example.com&gt; wrote:');
		expect(html).toContain('<blockquote><p>Body</p></blockquote>');
	});

	test('forward puts the header above the quote and escapes plain text', () => {
		const html = quoteHtml({
			kind: 'forward',
			from: 'ada@example.com',
			to: 'me@cloudmail.test',
			subject: 'Hello',
			createdAt: when.toISOString(),
			html: null,
			text: 'A & B',
			timeZone: 'UTC'
		});
		expect(html).toContain('From: ada@example.com');
		expect(html).toContain('Subject: Hello');
		expect(html).toContain('<blockquote><p>A &amp; B</p></blockquote>');
	});

	test('an empty body still quotes', () => {
		const html = quoteHtml({
			kind: 'reply',
			from: 'ada@example.com',
			to: null,
			subject: '',
			createdAt: when.toISOString(),
			html: null,
			text: '   ',
			timeZone: 'UTC'
		});
		expect(html).toContain('wrote:');
		expect(html).toContain('<blockquote></blockquote>');
	});
});

describe('quoteHtml with hostile html', () => {
	const quote = (html: string) =>
		quoteHtml({
			kind: 'reply',
			from: 'x@example.com',
			to: null,
			subject: 'Hi',
			createdAt: '2026-10-31T23:41:00Z',
			html,
			text: null,
			timeZone: 'UTC'
		});

	test('drops script, event handlers, and javascript: urls', () => {
		const html = quote(
			'<p onclick="steal()">Hi</p><img src=x onerror="fetch(\'/api/mail\')"><script>alert(1)</script>' +
				'<a href="javascript:alert(1)">link</a><iframe src="https://evil.example"></iframe><style>*{}</style>'
		);
		expect(html).not.toMatch(/onclick|onerror|<script|javascript:|<iframe|<style/i);
		expect(html).toContain('<p>Hi</p>');
	});

	test('keeps ordinary formatting', () => {
		const html = quote(
			'<div style="color:#333"><b>Bold</b> <a href="https://example.com">site</a><table><tr><td>cell</td></tr></table></div>'
		);
		expect(html).toContain('<div style="color:#333"><b>Bold</b> <a href="https://example.com">site</a>');
		expect(html).toContain('<td>cell</td>');
	});
});

describe('quoteHtml styles', () => {
	const quote = (html: string) =>
		quoteHtml({
			kind: 'forward',
			from: 'x@example.com',
			to: null,
			subject: 'Hi',
			createdAt: '2026-10-31T23:41:00Z',
			html,
			text: null,
			timeZone: 'UTC'
		});

	test('drops positioning and url() but keeps text styling', () => {
		const html = quote(
			'<div style="position:fixed;top:0;left:0;z-index:9999;color:#333;background-image:url(https://t.example/p.gif);font-weight:bold;margin:0 8px">x</div>'
		);
		expect(html).not.toMatch(/position|z-index|top:|left:|url\(/i);
		expect(html).toContain('color:#333');
		expect(html).toContain('font-weight:bold');
		expect(html).toContain('margin:0 8px');
	});
});

describe('quoteHtml remote images', () => {
	const quote = (remoteImages?: boolean) =>
		quoteHtml({
			kind: 'reply',
			from: 'x@example.com',
			to: null,
			subject: 'Hi',
			createdAt: '2026-10-31T23:41:00Z',
			html: '<p><img src="https://t.example/pixel.gif" alt="Logo"><img src="data:image/png;base64,AAAA"></p>',
			text: null,
			timeZone: 'UTC',
			remoteImages
		});

	test('holds remote images unless the sender is trusted', () => {
		const held = quote();
		expect(held).not.toContain('https://t.example');
		expect(held).toContain('[image: Logo]');
		expect(held).toContain('src="data:image/png;base64,AAAA"');
		expect(quote(true)).toContain('src="https://t.example/pixel.gif"');
	});
});

describe('quoteHtml remote image spellings', () => {
	const quote = (src: string) =>
		quoteHtml({
			kind: 'reply',
			from: 'x@example.com',
			to: null,
			subject: 'Hi',
			createdAt: '2026-10-31T23:41:00Z',
			html: `<img src="${src}" alt="x">`,
			text: null,
			timeZone: 'UTC'
		});

	test('every non-inline source is held, however it is written', () => {
		for (const src of ['https:\\\\t.example/p.gif', ' \thttps://t.example/p.gif', '//t.example/p', 'HTTPS://T.EXAMPLE/p', 'relative/p.gif', 'https:/t.example/p']) {
			const html = quote(src);
			expect(html).not.toContain('<img');
			expect(html).toContain('[image: x]');
		}
	});

	test('data and cid images stay', () => {
		expect(quote('data:image/png;base64,AAAA')).toContain('<img');
		expect(quote('cid:logo@x')).toContain('<img');
	});
});
