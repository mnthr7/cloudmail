import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DEMO_MODE, DEMO_USER, isDemoRequestAllowed } from '../src/lib/server/demo';

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? walk(path) : [path];
	});
}

describe('demo mode', () => {
	test('is off unless the server env opts in', () => {
		expect(DEMO_MODE).toBe(false);
	});

	test('demo user is never an admin', () => {
		expect(DEMO_USER.is_admin).toBe(false);
	});

	test('demo requests are read-only and never reach admin/setup/auth', () => {
		expect(isDemoRequestAllowed('GET', '/inbox')).toBe(true);
		expect(isDemoRequestAllowed('POST', '/api/mail')).toBe(false);
		expect(isDemoRequestAllowed('PATCH', '/api/preferences')).toBe(false);
		expect(isDemoRequestAllowed('GET', '/api/admin/users')).toBe(false);
		expect(isDemoRequestAllowed('GET', '/admin')).toBe(false);
		expect(isDemoRequestAllowed('GET', '/setup')).toBe(false);
	});

	test('no source file reads a ?demo URL parameter', () => {
		const offenders = walk('src').filter((file) => {
			const text = readFileSync(file, 'utf8');
			return /searchParams\.get\(\s*['"]demo['"]\s*\)|[?&]demo=1/.test(text);
		});
		expect(offenders).toEqual([]);
	});
});
