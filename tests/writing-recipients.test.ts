import { describe, expect, test } from 'bun:test';
import { replyRecipients } from '../src/lib/writing/recipients';

const own = ['me@cloudmail.test'];

describe('replyRecipients', () => {
	test('inbound reply uses Reply-To and reply all adds To and Cc', () => {
		const result = replyRecipients({
			direction: 'inbound',
			from: 'Ada <ada@example.com>',
			replyTo: 'List <list@example.com>',
			to: 'me@cloudmail.test, Bea <bea@example.com>',
			cc: 'Cy <cy@example.com>',
			bcc: 'hidden@example.com',
			own
		});
		expect(result.reply).toEqual(['list@example.com']);
		expect(result.replyAll).toEqual(['list@example.com', 'bea@example.com', 'cy@example.com']);
		expect(result.showReplyAll).toBe(true);
	});

	test('inbound without Reply-To uses From', () => {
		const result = replyRecipients({
			direction: 'inbound',
			from: 'Ada <ada@example.com>',
			replyTo: null,
			to: 'me@cloudmail.test',
			cc: null,
			bcc: null,
			own
		});
		expect(result.reply).toEqual(['ada@example.com']);
		expect(result.showReplyAll).toBe(false);
	});

	test('outbound reply uses To and drops own addresses', () => {
		const result = replyRecipients({
			direction: 'outbound',
			from: 'me@cloudmail.test',
			replyTo: null,
			to: 'Ada <ada@example.com>, me@cloudmail.test',
			cc: 'Bea <bea@example.com>',
			bcc: 'hidden@example.com',
			own
		});
		expect(result.reply).toEqual(['ada@example.com']);
		expect(result.replyAll).toEqual(['ada@example.com', 'bea@example.com']);
		expect(result.showReplyAll).toBe(true);
	});

	test('the first spelling wins', () => {
		const result = replyRecipients({
			direction: 'inbound',
			from: 'Ada <ADA@example.com>',
			replyTo: null,
			to: 'ada@example.com',
			cc: null,
			bcc: null,
			own
		});
		expect(result.reply).toEqual(['ada@example.com']);
		expect(result.replyAll).toEqual(['ada@example.com']);
	});
});
