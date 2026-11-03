import { describe, expect, test } from 'bun:test';
import { filterMatches, winningCategory } from '../src/lib/organizing/filters';

const mail = {
	from: 'Ada <ada@example.com>',
	to: 'you@cloudmail.test',
	subject: 'Invoice attached',
	bodyText: 'Please pay the balance',
	hasAttachment: true
};

describe('filterMatches', () => {
	test('every filled condition must match, and an empty rule matches nothing', () => {
		expect(filterMatches({}, mail)).toBe(false);
		expect(filterMatches({ matchFrom: 'ada@', matchSubject: 'invoice' }, mail)).toBe(true);
		expect(filterMatches({ matchFrom: 'ada@', matchSubject: 'hello' }, mail)).toBe(false);
	});

	test('words match the subject or the body, ignoring case', () => {
		expect(filterMatches({ matchWords: 'BALANCE' }, mail)).toBe(true);
		expect(filterMatches({ matchWords: 'missing' }, mail)).toBe(false);
	});

	test('the attachment flag requires an attachment only when it is on', () => {
		expect(filterMatches({ matchHasAttachment: true }, { ...mail, hasAttachment: false })).toBe(false);
		expect(filterMatches({ matchFrom: 'ada@' }, { ...mail, hasAttachment: false })).toBe(true);
	});

	test('the later matching filter wins the category', () => {
		const category = winningCategory(
			[
				{ matchFrom: 'ada@', actionCategory: 'promotions' },
				{ matchSubject: 'invoice', actionCategory: 'updates' },
				{ matchFrom: 'nobody', actionCategory: 'forums' }
			],
			mail
		);
		expect(category).toBe('updates');
	});
});
