import { describe, expect, test } from 'bun:test';
import { isHtmlEmpty } from '../src/lib/utils/html';

describe('isHtmlEmpty (server-safe, no DOMParser)', () => {
	test('empty paragraph is empty', () => {
		expect(isHtmlEmpty('<p></p>')).toBe(true);
	});

	test('visible text is not empty', () => {
		expect(isHtmlEmpty('<p>Hi</p>')).toBe(false);
	});
});
