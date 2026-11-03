import { describe, expect, test } from 'bun:test';
import { isReservedLocalPart } from '../src/lib/email-address';

describe('isReservedLocalPart', () => {
	test('role mailboxes are reserved, including case and plus-tags', () => {
		for (const local of ['postmaster', 'Abuse', 'billing+eu', ' security ', 'no-reply']) {
			expect(isReservedLocalPart(local)).toBe(true);
		}
	});

	test('personal names are not', () => {
		for (const local of ['ada', 'support-team', 'info2', 'adminton']) {
			expect(isReservedLocalPart(local)).toBe(false);
		}
	});
});

test('an @-suffix normalizes before the reserved check', () => {
	expect(isReservedLocalPart('postmaster@anything.example')).toBe(true);
	expect(isReservedLocalPart('Abuse+x@y')).toBe(true);
});
