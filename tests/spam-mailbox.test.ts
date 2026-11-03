import { describe, expect, test } from 'bun:test';
import { demoThreadInView } from '../src/lib/mailbox-view';

const inbound = {
	trashed: false,
	spam: false,
	is_draft: false,
	is_starred: false,
	direction: 'inbound'
};

describe('spam mailbox', () => {
	test('spam leaves the inbox and shows up in spam', () => {
		expect(demoThreadInView(inbound, 'inbox')).toBe(true);
		expect(demoThreadInView({ ...inbound, spam: true }, 'inbox')).toBe(false);
		expect(demoThreadInView({ ...inbound, spam: true }, 'spam')).toBe(true);
		expect(demoThreadInView({ ...inbound, spam: true }, 'starred')).toBe(false);
	});

	test('trash still wins over spam', () => {
		expect(demoThreadInView({ ...inbound, spam: true, trashed: true }, 'spam')).toBe(false);
		expect(demoThreadInView({ ...inbound, spam: true, trashed: true }, 'trash')).toBe(true);
	});
});
