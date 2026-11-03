import { describe, expect, test } from 'bun:test';
import { isPreviewableInline, mediaType } from '../src/lib/utils/attachments';

describe('isPreviewableInline', () => {
	test('shows plain images, pdf, and text inline', () => {
		for (const type of ['image/png', 'IMAGE/JPEG', 'application/pdf', 'text/plain; charset=utf-8', 'text/csv']) {
			expect(isPreviewableInline(type)).toBe(true);
		}
	});

	test('never inlines types that can run script on the app origin', () => {
		for (const type of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/xml', 'application/xml', 'text/javascript']) {
			expect(isPreviewableInline(type)).toBe(false);
		}
	});

	test('mediaType drops parameters and case', () => {
		expect(mediaType(' Text/HTML ; charset=UTF-8')).toBe('text/html');
	});
});
