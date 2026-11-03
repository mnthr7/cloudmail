import { describe, expect, test } from 'bun:test';
import { linkWarning } from '../src/lib/security/links';

describe('linkWarning', () => {
	test('names the real host when the visible host differs', () => {
		expect(linkWarning('https://paypal.com', 'https://evil.com/login')).toBe(
			'This link goes to evil.com, not paypal.com.'
		);
	});

	test('a subdomain of the real brand does not warn', () => {
		expect(linkWarning('inbox', 'https://mail.google.com/mail')).toBe(null);
	});

	test('a one-edit brand and a brand hidden in a longer host warn', () => {
		expect(linkWarning('Click here', 'https://paypa1.com/login')).toBe(
			'This address is not PayPal. It goes to paypa1.com.'
		);
		expect(linkWarning('Click here', 'https://paypal.evil.com/login')).toBe(
			'This address is not PayPal. It goes to paypal.evil.com.'
		);
	});

	test('punycode warns before the brand sentence', () => {
		expect(linkWarning('Click here', 'https://xn--pple-43d.com')).toBe(
			'This address uses lookalike characters.'
		);
	});

	test('matching mailto addresses do not warn', () => {
		expect(linkWarning('ada@paypal.com', 'mailto:ada@paypal.com')).toBe(null);
		expect(linkWarning('Ada@PayPal.com', 'mailto:ada@paypal.com')).toBe(null);
	});

	test('a different mailto address names both emails', () => {
		expect(linkWarning('ada@paypal.com', 'mailto:evil@phish.com')).toBe(
			'This link goes to evil@phish.com, not ada@paypal.com.'
		);
	});

	test('a port or query is not part of the host', () => {
		expect(linkWarning('https://paypal.com:443/login', 'https://paypal.com/login')).toBe(null);
		expect(linkWarning('https://paypal.com?x=1', 'https://evil.com/')).toBe(
			'This link goes to evil.com, not paypal.com.'
		);
	});
});
