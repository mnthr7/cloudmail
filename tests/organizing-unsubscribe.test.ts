import { describe, expect, test } from 'bun:test';
import { parseUnsubscribe, publicHttpsError } from '../src/lib/organizing/unsubscribe';

describe('unsubscribe targets', () => {
	test('parses the https and mailto targets', () => {
		const parsed = parseUnsubscribe('<https://news.test/u>, <mailto:bye@news.test>');
		expect(parsed.https).toBe('https://news.test/u');
		expect(parsed.mailto).toBe('bye@news.test');
		expect(parsed.subject).toBe(null);

		const withSubject = parseUnsubscribe('<mailto:bye@news.test?subject=Go>');
		expect(withSubject.mailto).toBe('bye@news.test');
		expect(withSubject.subject).toBe('Go');
	});

	test('refuses private, local, and non-https targets', () => {
		expect(publicHttpsError('http://news.test/u')).toBe('https');
		expect(publicHttpsError('https://localhost/u')).toBe('private');
		expect(publicHttpsError('https://127.0.0.1/u')).toBe('private');
		expect(publicHttpsError('https://10.1.2.3/u')).toBe('private');
		expect(publicHttpsError('https://192.168.1.9/u')).toBe('private');
		expect(publicHttpsError('https://169.254.1.1/u')).toBe('private');
		expect(publicHttpsError('https://100.64.0.1/u')).toBe('private');
		expect(publicHttpsError('https://[fd00::1]/u')).toBe('private');
		expect(publicHttpsError('https://[fc00::1]/u')).toBe('private');
		expect(publicHttpsError('https://[::ffff:127.0.0.1]/u')).toBe('private');
		expect(publicHttpsError('https://[::ffff:169.254.169.254]/u')).toBe('private');
		expect(publicHttpsError('https://[::ffff:8.8.8.8]/u')).toBe(null);
		expect(publicHttpsError('https://fda.gov/u')).toBe(null);
		expect(publicHttpsError('https://fdic.gov/u')).toBe(null);
		expect(publicHttpsError('https://news.test/u')).toBe(null);
	});
});
