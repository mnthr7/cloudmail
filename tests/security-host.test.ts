import { describe, expect, test } from 'bun:test';
import { mixedScripts, oneEditAway, registrableDomain } from '../src/lib/security/host';
import { organizationDomain } from '../src/lib/security/organization';
import { senderWarning } from '../src/lib/security/sender';

describe('registrableDomain', () => {
	test('strips one www, a trailing dot, and case, then keeps the last two labels', () => {
		expect(registrableDomain('Mail.Google.com.')).toBe('google.com');
		expect(registrableDomain('www.google.com')).toBe('google.com');
		expect(registrableDomain('accounts.google.com')).toBe('google.com');
	});
});

describe('organizationDomain', () => {
	test('reads the Public Suffix List, so siblings under a shared suffix stay apart', () => {
		expect(organizationDomain('Mail.Google.com.')).toBe('google.com');
		expect(organizationDomain('www.google.com')).toBe('google.com');
		expect(organizationDomain('mail.victim.co.uk')).toBe('victim.co.uk');
		expect(organizationDomain('attacker.co.uk')).toBe('attacker.co.uk');
		expect(organizationDomain('shop.victim.com.au')).toBe('victim.com.au');
		expect(organizationDomain('attacker.com.au')).toBe('attacker.com.au');
		// Private suffixes too: anyone can take a name under github.io.
		expect(organizationDomain('alice.github.io')).toBe('alice.github.io');
		expect(organizationDomain('docs.bob.github.io')).toBe('bob.github.io');
	});

	test("hosts the list can't place come back as themselves", () => {
		expect(organizationDomain('co.uk')).toBe('co.uk');
		expect(organizationDomain('github.io')).toBe('github.io');
		expect(organizationDomain('localhost')).toBe('localhost');
		expect(organizationDomain('192.0.2.1')).toBe('192.0.2.1');
		expect(organizationDomain('')).toBe('');
	});
});

describe('senderWarning with the Public Suffix List', () => {
	test('a sibling under co.uk named in the display name is caught', () => {
		expect(senderWarning('victim.co.uk Billing <billing@attacker.co.uk>', organizationDomain)).toBe(
			'This name includes victim.co.uk, but the message is from billing@attacker.co.uk.'
		);
		expect(senderWarning('victim.co.uk Billing <billing@mail.victim.co.uk>', organizationDomain)).toBeNull();
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
