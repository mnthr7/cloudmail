import { describe, expect, test } from 'bun:test';
import { parseThreshold, scanVerdict } from '../src/lib/security/verdict';

describe('scan verdict', () => {
	test('accepts a whole number from 1 to 70', () => {
		expect(parseThreshold(1)).toBe(1);
		expect(parseThreshold(70)).toBe(70);
		expect(parseThreshold(0)).toBe(null);
		expect(parseThreshold(1.5)).toBe(null);
		expect(parseThreshold('1')).toBe(null);
	});

	test('suspicious is not part of the count the caller passes', () => {
		expect(scanVerdict(0, 1)).toBe('clean');
		expect(scanVerdict(1, 1)).toBe('infected');
		expect(scanVerdict(2, 3)).toBe('clean');
	});
});
