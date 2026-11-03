import { describe, expect, test } from 'bun:test';
import { clampDragWidth, widthForPreset } from '../src/lib/utils/image-size';

describe('composer image sizes', () => {
	test('small is 200px and does not enlarge a smaller image', () => {
		expect(widthForPreset('small', 1200, 520)).toBe(200);
		expect(widthForPreset('small', 80, 520)).toBe(80);
	});

	test('best fit uses the compose column and original uses the file width', () => {
		expect(widthForPreset('best', 1200, 520)).toBe(520);
		expect(widthForPreset('original', 1200, 520)).toBe(1200);
	});

	test('dragging stays between a minimum and the column width', () => {
		expect(clampDragWidth(10, 520)).toBe(48);
		expect(clampDragWidth(300, 520)).toBe(300);
		expect(clampDragWidth(900, 520)).toBe(520);
	});
});
