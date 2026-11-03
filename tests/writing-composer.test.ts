import { describe, expect, test } from 'bun:test';
import { composerDraft } from '../src/lib/writing/composer';

describe('composerDraft', () => {
	test('forward leaves To empty and quotes the original', () => {
		const draft = composerDraft({
			mode: 'forward',
			from: 'Ada <ada@example.com>',
			replyTo: null,
			to: 'me@cloudmail.test',
			cc: null,
			bcc: 'hidden@example.com',
			own: ['me@cloudmail.test'],
			subject: 'Hello',
			createdAt: '2026-10-31T23:41:00Z',
			html: '<p>Body</p>',
			text: null,
			timeZone: 'UTC',
			signatureHtml: '<p>Sig</p>'
		});
		expect(draft.to).toEqual([]);
		expect(draft.subject).toBe('Fwd: Hello');
		expect(draft.html).toContain('data-qm-signature="1"');
		expect(draft.html).toContain('<blockquote><p>Body</p></blockquote>');
		expect(draft.html.indexOf('data-qm-signature')).toBeLessThan(draft.html.indexOf('<blockquote>'));
	});

	test('reply all is hidden when nobody else remains', () => {
		const draft = composerDraft({
			mode: 'reply-all',
			from: 'Ada <ada@example.com>',
			replyTo: null,
			to: 'me@cloudmail.test',
			cc: null,
			bcc: null,
			own: ['me@cloudmail.test'],
			subject: 'Hello',
			createdAt: '2026-10-31T23:41:00Z',
			html: null,
			text: 'Hi',
			timeZone: 'UTC',
			signatureHtml: null
		});
		expect(draft.showReplyAll).toBe(false);
		expect(draft.to).toEqual(['ada@example.com']);
		expect(draft.subject).toBe('Re: Hello');
	});
});
