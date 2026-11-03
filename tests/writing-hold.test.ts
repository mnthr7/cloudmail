import { describe, expect, test } from 'bun:test';
import { holdDelay } from '../src/lib/writing/hold-send';

describe('holdDelay', () => {
	test('waits until sendAt and never waits a negative time', () => {
		const now = new Date('2026-10-31T23:00:00Z');
		expect(holdDelay('2026-10-31T23:00:10.000Z', now)).toBe(10_000);
		expect(holdDelay('2026-10-31T22:59:00.000Z', now)).toBe(0);
	});
});
