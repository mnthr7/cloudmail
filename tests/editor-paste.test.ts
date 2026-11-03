import { describe, expect, test } from 'bun:test';
import { normalizePastedText, plainTextFromHtml } from '../src/lib/utils/editor-paste';

describe('composer paste text', () => {
	test('keeps line breaks from clipboard html when plain text is missing', () => {
		expect(plainTextFromHtml('<p>Hello</p><p>there</p>')).toBe('Hello\nthere\n');
		expect(plainTextFromHtml('A<br>B')).toBe('A\nB');
		expect(plainTextFromHtml('Tom &amp; Jerry')).toBe('Tom & Jerry');
	});

	test('normalizes windows newlines', () => {
		expect(normalizePastedText('a\r\nb\rc')).toBe('a\nb\nc');
	});
});
