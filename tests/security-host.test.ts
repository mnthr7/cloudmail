import { describe, expect, test } from 'bun:test';
import { mixedScripts, oneEditAway, registrableDomain } from '../src/lib/security/host';

describe('registrableDomain', () => {
	test('strips one www, a trailing dot, and case, then keeps the last two labels', () => {
		expect(registrableDomain('Mail.Google.com.')).toBe('google.com');
		expect(registrableDomain('www.google.com')).toBe('google.com');
		expect(registrableDomain('accounts.google.com')).toBe('google.com');
	});
});

describe('oneEditAway', () => {
	test('is one insert, delete, or substitution, and not equality', () => {
		expect(oneEditAway('paypal', 'paypa1')).toBe(true);
		expect(oneEditAway('paypal', 'paypal')).toBe(false);
		expect(oneEditAway('paypal', 'pay')).toBe(false);
	});
});

describe('mixedScripts', () => {
	test('is true when letters come from two scripts', () => {
		expect(mixedScripts('payp\u0430l.com')).toBe(true);
		expect(mixedScripts('paypal.com')).toBe(false);
		expect(mixedScripts('pay-pal.com')).toBe(false);
	});
});
