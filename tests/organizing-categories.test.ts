import { describe, expect, test } from 'bun:test';
import { assignCategory } from '../src/lib/organizing/categories';

describe('assignCategory', () => {
	test('a saved sender category wins over the headers', () => {
		expect(
			assignCategory(
				{ listUnsubscribe: '<mailto:a@b.test>' },
				'forums'
			)
		).toBe('forums');
	});

	test('a list with a reply chain is forums', () => {
		expect(
			assignCategory(
				{ listId: '<dev.example>', inReplyTo: '<m@example>', listUnsubscribe: '<mailto:a@b.test>' },
				null
			)
		).toBe('forums');
	});

	test('list-unsubscribe or bulk precedence is promotions', () => {
		expect(assignCategory({ listUnsubscribe: '<https://ex.test/u>' }, null)).toBe('promotions');
		expect(assignCategory({ precedence: 'Bulk' }, null)).toBe('promotions');
	});

	test('auto-submitted and noreply local-parts are updates', () => {
		expect(assignCategory({ autoSubmitted: 'auto-generated' }, null)).toBe('updates');
		expect(assignCategory({ from: 'Billing <billing@shop.test>' }, null)).toBe('updates');
		expect(assignCategory({ autoSubmitted: 'no' }, null)).toBe('primary');
	});

	test('known social domains, including subdomains, are social', () => {
		expect(assignCategory({ from: 'notify@mail.linkedin.com' }, null)).toBe('social');
	});

	test('everything else is primary', () => {
		expect(assignCategory({ from: 'ada@example.com' }, null)).toBe('primary');
	});
});
