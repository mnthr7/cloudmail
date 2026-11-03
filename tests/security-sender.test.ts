import { describe, expect, test } from 'bun:test';
import { senderWarning } from '../src/lib/security/sender';

describe('senderWarning', () => {
	test('a name with no email or domain does not warn', () => {
		expect(senderWarning('PayPal <evil@phish.com>')).toBe(null);
	});

	test('an email in the name that is not the From address warns', () => {
		expect(senderWarning('ada@paypal.com <evil@phish.com>')).toBe(
			'This name includes ada@paypal.com, but the message is from evil@phish.com.'
		);
	});

	test('a domain in the name warns, and a filename does not', () => {
		expect(senderWarning('Ada paypal.com <ada@example.com>')).toBe(
			'This name includes paypal.com, but the message is from ada@example.com.'
		);
		expect(senderWarning('Invoice invoice.pdf <ada@example.com>')).toBe(null);
	});
});
