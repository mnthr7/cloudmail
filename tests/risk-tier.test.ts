import { describe, expect, test } from 'bun:test';
import { classify } from '../scripts/risk-tier.mjs';

describe('risk tiers', () => {
	test('docs, tests, styles, and raster images are low risk', () => {
		expect(
			classify([
				'README.md',
				'docs/specs/agent-staff-platform.md',
				'docs/screenshots/01-inbox-ledger.png',
				'tests/agents-store.test.ts',
				'src/routes/layout.css',
				'src/lib/skins/desk.css',
				'static/robots.txt',
				'static/icon.webp'
			])
		).toEqual({ tier: 'low', highRisk: [], dependenciesOnly: false });
	});

	test('one sensitive file makes the whole change high risk, and is named', () => {
		expect(classify(['README.md', 'src/lib/server/auth.ts'])).toEqual({
			tier: 'high',
			highRisk: ['src/lib/server/auth.ts'],
			dependenciesOnly: false
		});
	});

	test('dependency-only changes are spotted for Dependabot', () => {
		expect(classify(['package.json', 'bun.lock']).dependenciesOnly).toBe(true);
		expect(classify(['package.json', 'bun.lock']).tier).toBe('high');
		expect(classify(['package.json', 'src/worker.ts']).dependenciesOnly).toBe(false);
		expect(classify(['.github/workflows/ci.yml']).dependenciesOnly).toBe(false);
		expect(classify([]).dependenciesOnly).toBe(false);
	});

	test.each([
		'src/lib/server/agents-store.ts',
		'src/lib/agents/policy.ts',
		'src/routes/api/agents/+server.ts',
		'src/routes/staff/+page.server.ts',
		'src/routes/+layout.server.ts',
		'src/hooks.server.ts',
		'src/worker.ts',
		'migrations/0016_anything.sql',
		'wrangler.jsonc',
		'package.json',
		'bun.lock',
		'.github/workflows/ci.yml',
		'.github/workflows/risk-tier.yml',
		'.github/CODEOWNERS',
		'scripts/risk-tier.mjs',
		'src/lib/components/EmailBody.svelte',
		'src/lib/components/RichTextEditor.svelte',
		'src/lib/components/Sidebar.svelte',
		'src/routes/staff/+page.svelte',
		'src/routes/+layout.svelte',
		'src/lib/assets/logo.svg',
		'static/evil.svg',
		'static/index.html',
		'static/app.js',
		'static/_headers',
		'static/_redirects',
		'.vscode/tasks.json',
		'.vscode/settings.json',
		'src/lib/security/links.ts',
		'src/lib/components/nested/Thing.svelte',
		'something-new/file.ts'
	])('%s needs a human', (path) => {
		expect(classify([path]).tier).toBe('high');
	});

	test('a change with no files listed needs a human', () => {
		expect(classify([]).tier).toBe('high');
		expect(classify(['', '  ']).tier).toBe('high');
	});

	test('look-alike paths do not slip through', () => {
		expect(classify(['docs.ts']).tier).toBe('high');
		expect(classify(['src/routes/+page.svelte.ts']).tier).toBe('high');
		expect(classify(['testsuite/x.ts']).tier).toBe('high');
	});
});
