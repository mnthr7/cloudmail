import { describe, expect, test } from 'bun:test';
import { holdRemoteImages } from '../src/lib/security/images';

describe('holdRemoteImages', () => {
	test('moves http, https, and protocol-relative urls off img and source', () => {
		const result = holdRemoteImages(
			'<img src="https://cdn.test/a.png"><img src="//cdn.test/b.png"><source srcset="http://cdn.test/c.png 1x">'
		);
		expect(result.held).toBe(true);
		expect(result.html).not.toContain(' src="https://');
		expect(result.html).not.toContain(' src="//');
		expect(result.html).not.toContain(' srcset="http://');
		expect(result.html).toContain('data-qm-src="https://cdn.test/a.png"');
		expect(result.html).toContain('data-qm-src="https://cdn.test/b.png"');
		expect(result.html).toContain('data-qm-srcset="http://cdn.test/c.png 1x"');
	});

	test('leaves data and cid urls in place', () => {
		const html = '<img src="data:image/png;base64,aa"><img src="cid:logo">';
		expect(holdRemoteImages(html)).toEqual({ html, held: false });
	});

	test('holds an unquoted remote src', () => {
		expect(holdRemoteImages('<img src=https://cdn.test/a.png>')).toEqual({
			html: '<img data-qm-src="https://cdn.test/a.png">',
			held: true
		});
	});

	test('holds every duplicate src', () => {
		expect(
			holdRemoteImages('<img src="https://a.test/1.png" src="https://evil.test/a.png">')
		).toEqual({
			html: '<img data-qm-src="https://a.test/1.png" data-qm-src="https://evil.test/a.png">',
			held: true
		});
	});

	test('does not let a quoted title hide a remote src', () => {
		expect(holdRemoteImages(`<img title=' src="cid:x"' src="https://evil.test/a.png">`)).toEqual({
			html: `<img title=' src="cid:x"' data-qm-src="https://evil.test/a.png">`,
			held: true
		});
	});

	test('holds a srcset jammed against src', () => {
		expect(
			holdRemoteImages('<img src="https://a.test/1.png"srcset="http://evil.test/a.png 1x">')
		).toEqual({
			html: '<img data-qm-src="https://a.test/1.png" data-qm-srcset="http://evil.test/a.png 1x">',
			held: true
		});
	});

	test('finds an img after a character that grows when lowercased', () => {
		expect(holdRemoteImages('İ<img src="https://evil.test/a.png">')).toEqual({
			html: 'İ<img data-qm-src="https://evil.test/a.png">',
			held: true
		});
	});

	test('a quote in an unquoted value does not swallow the next image', () => {
		expect(holdRemoteImages('<img alt=x"><img src="https://evil.test/a.png">')).toEqual({
			html: '<img alt=x"><img data-qm-src="https://evil.test/a.png">',
			held: true
		});
	});

	test('holds a later srcset url that starts with a control character', () => {
		expect(
			holdRemoteImages('<img srcset="data:image/gif,&#1;https://evil.test/a.png">')
		).toEqual({
			html: '<img data-qm-srcset="data:image/gif,\u0001https://evil.test/a.png">',
			held: true
		});
	});

	test('keeps a srcset descriptor that sat after a newline', () => {
		expect(holdRemoteImages('<img srcset="https://cdn.test/a.png\n1x">')).toEqual({
			html: '<img data-qm-srcset="https://cdn.test/a.png\n1x">',
			held: true
		});
	});

	test('holds image urls written as character references', () => {
		for (const src of [
			'https&#58;//evil.test/a.png',
			'https&#x3a;//evil.test/a.png',
			'&#104;ttps://evil.test/a.png',
			'https&colon;//evil.test/a.png',
			'https&colon;&sol;&sol;evil.test/a.png',
			'https:&#9;//evil.test/a.png',
			'&#1;https://evil.test/a.png'
		]) {
			expect(holdRemoteImages(`<img src="${src}">`)).toEqual({
				html: '<img data-qm-src="https://evil.test/a.png">',
				held: true
			});
		}
	});
});
