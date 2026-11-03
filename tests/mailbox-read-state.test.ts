import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	applyThreadReadState,
	conversationKey,
	threadMatchesMailboxId
} from '../src/lib/mailbox-read-state';

function thread(overrides: { thread_id: string; latest_id: string; is_read: boolean }) {
	return overrides;
}

describe('conversationKey', () => {
	test('uses thread_id when present', () => {
		expect(conversationKey({ id: 'msg-2', thread_id: 'thread-1' })).toBe('thread-1');
	});

	test('falls back to the message id when thread_id is missing', () => {
		expect(conversationKey({ id: 'msg-1', thread_id: null })).toBe('msg-1');
		expect(conversationKey({ id: 'msg-1' })).toBe('msg-1');
	});
});

describe('threadMatchesMailboxId', () => {
	const row = thread({ thread_id: 'thread-1', latest_id: 'msg-9', is_read: false });

	test('matches the newest message id used to open the row', () => {
		expect(threadMatchesMailboxId(row, 'msg-9')).toBe(true);
	});

	test('matches the conversation key', () => {
		expect(threadMatchesMailboxId(row, 'thread-1')).toBe(true);
	});

	test('does not match a sibling message id', () => {
		expect(threadMatchesMailboxId(row, 'msg-1')).toBe(false);
	});
});

describe('applyThreadReadState', () => {
	const threads = [
		thread({ thread_id: 'thread-1', latest_id: 'msg-1', is_read: false }),
		thread({ thread_id: 'thread-2', latest_id: 'msg-2', is_read: false }),
		thread({ thread_id: 'thread-3', latest_id: 'msg-3', is_read: true })
	];

	test('marks the opened latest_id read and leaves others alone', () => {
		const next = applyThreadReadState(threads, 'msg-1', true);
		expect(next[0].is_read).toBe(true);
		expect(next[1].is_read).toBe(false);
		expect(next[2].is_read).toBe(true);
		expect(next[0]).not.toBe(threads[0]);
		expect(next[1]).toBe(threads[1]);
	});

	test('marks a row read when the url id is the conversation key', () => {
		const next = applyThreadReadState(threads, 'thread-2', true);
		expect(next[1].is_read).toBe(true);
	});

	test('can mark unread again from the row or toolbar', () => {
		const next = applyThreadReadState(threads, ['msg-3'], false);
		expect(next[2].is_read).toBe(false);
		expect(next[0].is_read).toBe(false);
	});

	test('returns the same array when no ids match', () => {
		expect(applyThreadReadState(threads, [], true)).toBe(threads);
	});
});

describe('split-view open refreshes mailbox data', () => {
	const splitView = readFileSync(resolve('src/lib/components/MailboxSplitView.svelte'), 'utf8');

	test('loadThread invalidates after a successful in-pane fetch', () => {
		const start = splitView.indexOf('async function loadThread');
		expect(start).toBeGreaterThan(-1);
		const body = splitView.slice(start, splitView.indexOf('function handleThreadSelect', start));
		expect(body).toContain('invalidateAll()');
		expect(body).toMatch(/if\s*\(\s*res\.ok\s*\)[\s\S]*invalidateAll\(\)/);
	});
});
