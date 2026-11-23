import { describe, expect, test } from 'bun:test';
import { safeReturnPath } from '../src/lib/return-path';

describe('where sign-in sends you back', () => {
	test('only to the consent screen on this site', () => {
		expect(safeReturnPath('/oauth/authorize?client_id=a&state=b')).toBe('/oauth/authorize?client_id=a&state=b');
		expect(safeReturnPath('/inbox')).toBeNull();
		expect(safeReturnPath('//evil.com/oauth/authorize')).toBeNull();
		expect(safeReturnPath('https://evil.com/oauth/authorize')).toBeNull();
		expect(safeReturnPath('/\\evil.com/oauth/')).toBeNull();
		expect(safeReturnPath(null)).toBeNull();
	});
});
