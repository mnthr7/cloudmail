import { describe, expect, test } from 'bun:test';
import { classify } from '../scripts/risk-tier.mjs';

describe('risk tiers', () => {
	test('docs, tests, and UI-only changes are low risk', () => {
		expect(
			classify([
				'README.md',
				'docs/specs/agent-staff-platform.md',
				'tests/agents-store.test.ts',
				'src/routes/staff/+page.svelte',
				'src/lib/components/Sidebar.svelte',
				'src/routes/layout.css',
				'src/lib/skins/desk.css'
			])
		).toEqual({ tier: 'low', highRisk: [] });
	});

	test('one sensitive file makes the whole change high risk, and is named', () => {
		expect(classify(['README.md', 'src/lib/server/auth.ts'])).toEqual({
			tier: 'high',
			highRisk: ['src/lib/server/auth.ts']
		});
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
		'src/lib/security/links.ts',
		'src/lib/components/nested/Thing.svelte',
		'something-new/file.ts'
	])('%s needs a human', (path) => {
		expect(classify([path]).tier).toBe('high');
	});

	test('a change with no files listed needs a human', () => {
		expect(classify([])).toEqual({ tier: 'high', highRisk: [] });
		expect(classify(['', '  '])).toEqual({ tier: 'high', highRisk: [] });
	});

	test('look-alike paths do not slip through', () => {
		expect(classify(['docs.ts']).tier).toBe('high');
		expect(classify(['src/routes/+page.svelte.ts']).tier).toBe('high');
		expect(classify(['testsuite/x.ts']).tier).toBe('high');
	});
});
