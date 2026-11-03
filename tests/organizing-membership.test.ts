import { describe, expect, test } from 'bun:test';
import { conversationInView } from '../src/lib/organizing/membership';

const now = new Date('2026-10-29T15:00:00.000Z');
const inbound = {
	trashed: false,
	spam: false,
	isDraft: false,
	isStarred: false,
	direction: 'inbound' as const,
	inInbox: true,
	category: 'primary' as const,
	labelIds: ['label-1']
};

describe('conversationInView', () => {
	test('archive leaves the inbox and stays in all mail', () => {
		expect(conversationInView(inbound, 'inbox', now)).toBe(true);
		expect(conversationInView({ ...inbound, inInbox: false }, 'inbox', now)).toBe(false);
		expect(conversationInView({ ...inbound, inInbox: false }, 'all', now)).toBe(true);
	});

	test('a future snooze hides the inbox and a past snooze shows it', () => {
		const snoozed = { ...inbound, snoozedUntil: '2026-10-29T18:00:00.000Z' };
		expect(conversationInView(snoozed, 'inbox', now)).toBe(false);
		expect(conversationInView(snoozed, 'snoozed', now)).toBe(true);
		expect(
			conversationInView({ ...inbound, snoozedUntil: '2026-10-29T14:00:00.000Z' }, 'inbox', now)
		).toBe(true);
	});

	test('spam and trash still win, and a label does not include other labels', () => {
		expect(conversationInView({ ...inbound, spam: true }, 'all', now)).toBe(false);
		expect(conversationInView({ ...inbound, trashed: true }, 'trash', now)).toBe(true);
		expect(conversationInView(inbound, 'all', now, 'label-1')).toBe(true);
		expect(conversationInView(inbound, 'all', now, 'label-2')).toBe(false);
	});

	test('the inbox tab only shows that category', () => {
		expect(conversationInView({ ...inbound, category: 'promotions' }, 'inbox', now, undefined, 'primary')).toBe(false);
		expect(conversationInView({ ...inbound, category: 'promotions' }, 'inbox', now, undefined, 'promotions')).toBe(true);
	});

	test('scheduled mail is in Scheduled and All Mail, and out of Sent and Drafts', () => {
		const waiting = { direction: 'outbound' as const, isScheduled: true };
		expect(conversationInView(waiting, 'scheduled')).toBe(true);
		expect(conversationInView(waiting, 'all')).toBe(true);
		expect(conversationInView(waiting, 'sent')).toBe(false);
		expect(conversationInView(waiting, 'drafts')).toBe(false);
	});
});
