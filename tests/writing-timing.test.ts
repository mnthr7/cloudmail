import { describe, expect, test } from 'bun:test';
import { AUTOSAVE_MS, shouldAutosave } from '../src/lib/writing/autosave';
import { holdUntil, parseUndoSeconds, scheduleError } from '../src/lib/writing/timing';

const now = new Date('2026-10-31T23:00:00Z');

describe('send timing', () => {
	test('accepts only the four undo delays', () => {
		expect(parseUndoSeconds(10)).toBe(10);
		expect(parseUndoSeconds('20')).toBe(null);
		expect(parseUndoSeconds(15)).toBe(null);
	});

	test('a hold is now plus the delay', () => {
		expect(holdUntil(now, 10)).toBe('2026-10-31T23:00:10.000Z');
	});

	test('a schedule must be at least a minute ahead', () => {
		expect(scheduleError('2026-10-31T23:00:59.000Z', now)).toBe(
			'Pick a time at least a minute from now.'
		);
		expect(scheduleError('2026-10-31T23:01:00.000Z', now)).toBe(null);
	});

	test('autosave waits for a user edit', () => {
		expect(shouldAutosave(false)).toBe(false);
		expect(shouldAutosave(true)).toBe(true);
	});

	test('the autosave wait is two seconds', () => {
		expect(AUTOSAVE_MS).toBe(2000);
	});
});
