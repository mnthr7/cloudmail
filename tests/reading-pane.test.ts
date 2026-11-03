import { describe, expect, test } from 'bun:test';
import {
	READING_PANE_SPLIT_MIN_WIDTH,
	parseReadingPanePreference,
	resolveReadingPaneLayout
} from '../src/lib/reading-pane';

describe('parseReadingPanePreference', () => {
	test('defaults to right of inbox', () => {
		expect(parseReadingPanePreference(null)).toBe('right');
		expect(parseReadingPanePreference('')).toBe('right');
		expect(parseReadingPanePreference('bogus')).toBe('right');
	});

	test('accepts the three Gmail-style values', () => {
		expect(parseReadingPanePreference('none')).toBe('none');
		expect(parseReadingPanePreference('right')).toBe('right');
		expect(parseReadingPanePreference('below')).toBe('below');
	});
});

describe('resolveReadingPaneLayout', () => {
	test('forces no-split under the desktop breakpoint', () => {
		expect(resolveReadingPaneLayout('right', READING_PANE_SPLIT_MIN_WIDTH - 1)).toBe('none');
		expect(resolveReadingPaneLayout('below', 800)).toBe('none');
		expect(resolveReadingPaneLayout('none', 390)).toBe('none');
	});

	test('honors the stored preference on wide viewports', () => {
		expect(resolveReadingPaneLayout('right', READING_PANE_SPLIT_MIN_WIDTH)).toBe('right');
		expect(resolveReadingPaneLayout('below', 1280)).toBe('below');
		expect(resolveReadingPaneLayout('none', 1440)).toBe('none');
	});
});
