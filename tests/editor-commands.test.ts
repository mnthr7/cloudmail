import { describe, expect, test } from 'bun:test';
import { EDITOR_COMMANDS } from '../src/lib/writing/editor-commands';

describe('EDITOR_COMMANDS', () => {
	test('keeps the current controls and adds the writing set', () => {
		const names = EDITOR_COMMANDS.map((command) => command.label);
		expect(names).toEqual([
			'Bold', 'Italic', 'Underline', 'Strikethrough', 'Link',
			'Bulleted list', 'Numbered list', 'Quote',
			'Align left', 'Align center', 'Align right',
			'Indent', 'Outdent',
			'Sans', 'Serif', 'Mono',
			'Small', 'Normal', 'Large', 'Huge',
			'Black', 'Red', 'Orange', 'Green', 'Blue', 'Violet', 'Clear color'
		]);
	});
});
