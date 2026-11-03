import { describe, expect, test } from 'bun:test';
import { inboxUndoTargets } from '../src/lib/organizing/inbox-undo';

describe('inboxUndoTargets', () => {
	test('archive undo restores only conversations that were in the inbox', () => {
		expect(
			inboxUndoTargets(['in', 'out', 'in-2'], 'archive', { inboxIds: ['in', 'in-2'] })
		).toEqual(['in', 'in-2']);
	});

	test('move-to-inbox undo archives only conversations that were not in the inbox', () => {
		expect(
			inboxUndoTargets(['in', 'out', 'out-2'], 'inbox', { inboxIds: ['in'] })
		).toEqual(['out', 'out-2']);
	});

	test('a single conversation undoes the whole selection', () => {
		expect(inboxUndoTargets(['one'], 'archive', { inInbox: true })).toEqual(['one']);
		expect(inboxUndoTargets(['one'], 'inbox', { inInbox: false })).toEqual(['one']);
	});

	test('a uniform bulk selection undoes every selected id', () => {
		expect(inboxUndoTargets(['a', 'b'], 'archive', { inInbox: true, inboxMixed: false })).toEqual([
			'a',
			'b'
		]);
		expect(inboxUndoTargets(['a', 'b'], 'inbox', { inInbox: false, inboxMixed: false })).toEqual([
			'a',
			'b'
		]);
	});

	test('ids outside the selection are ignored', () => {
		expect(inboxUndoTargets(['in'], 'archive', { inboxIds: ['in', 'other'] })).toEqual(['in']);
	});
});
