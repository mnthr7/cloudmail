import { describe, expect, test } from 'bun:test';
import { forwardSubject, replySubject } from '../src/lib/writing/subject';

describe('subject prefixes', () => {
	test('adds Re: and Fwd: once', () => {
		expect(replySubject('Hello')).toBe('Re: Hello');
		expect(replySubject('re: Hello')).toBe('re: Hello');
		expect(replySubject('Fwd: Hello')).toBe('Re: Fwd: Hello');
		expect(forwardSubject('Hello')).toBe('Fwd: Hello');
		expect(forwardSubject('FW: Hello')).toBe('FW: Hello');
		expect(forwardSubject('Re: Hello')).toBe('Fwd: Re: Hello');
	});
});
