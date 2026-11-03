import { describe, expect, test } from 'bun:test';
import { isFutureInstant, snoozeInstant } from '../src/lib/organizing/snooze';

describe('snoozeInstant', () => {
	test('later today is 18:00 local before 16:00', () => {
		const now = new Date(2026, 9, 29, 10, 0, 0);
		const instant = new Date(snoozeInstant('later', now));
		expect(instant.getFullYear()).toBe(2026);
		expect(instant.getMonth()).toBe(9);
		expect(instant.getDate()).toBe(29);
		expect(instant.getHours()).toBe(18);
	});

	test('later today after 16:00 is 20:00, and rolls forward once that has passed', () => {
		const afternoon = new Date(2026, 9, 29, 17, 0, 0);
		expect(new Date(snoozeInstant('later', afternoon)).getHours()).toBe(20);
		const night = new Date(2026, 9, 29, 21, 0, 0);
		const rolled = new Date(snoozeInstant('later', night));
		expect(rolled.getDate()).toBe(30);
		expect(rolled.getHours()).toBe(8);
	});

	test('tomorrow is the next day at 08:00 and next week is the next Monday at 08:00', () => {
		const thursday = new Date(2026, 9, 29, 12, 0, 0);
		expect(new Date(snoozeInstant('tomorrow', thursday)).getDate()).toBe(30);
		expect(new Date(snoozeInstant('tomorrow', thursday)).getHours()).toBe(8);
		const monday = new Date(snoozeInstant('next-week', thursday));
		expect(monday.getDay()).toBe(1);
		expect(monday.getDate()).toBe(2);
		expect(monday.getHours()).toBe(8);
	});

	test('a past instant is rejected', () => {
		const now = new Date('2026-10-29T15:00:00.000Z');
		expect(isFutureInstant('2026-10-29T14:00:00.000Z', now)).toBe(false);
		expect(isFutureInstant('2026-10-29T16:00:00.000Z', now)).toBe(true);
		expect(isFutureInstant('not-a-date', now)).toBe(false);
	});
});
