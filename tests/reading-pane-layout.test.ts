import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const layoutCss = readFileSync(resolve('src/routes/layout.css'), 'utf8');
const splitView = readFileSync(resolve('src/lib/components/MailboxSplitView.svelte'), 'utf8');

function blockAfter(source: string, marker: string): string {
	const start = source.indexOf(marker);
	if (start < 0) return '';
	const slice = source.slice(start);
	const end = slice.search(/\n\s*\/\*|\nhtml\[|\n@media|\n<\/style>/);
	return end >= 0 ? slice.slice(0, end) : slice;
}

describe('below-inbox split height chain', () => {
	test('app-shell has a definite viewport height so column percentages resolve', () => {
		expect(layoutCss).toMatch(/\.app-shell\s*\{[^}]*[\s;{]height:\s*100(?:vh|dvh)/s);
		expect(layoutCss).toMatch(/\.app-content\s*\{[^}]*\bmin-height:\s*0/s);
	});

	test('below-inbox keeps a non-zero thread row on desktop', () => {
		const below = blockAfter(layoutCss, "html[data-reading-pane='below'] .split-layout {");
		expect(below).toMatch(/grid-template-rows:[^;]*minmax\(0,\s*1fr\)/);
		expect(layoutCss).toContain("html[data-reading-pane='below'] .split-layout .list-pane:has(+ .thread-pane.has-thread)");
		expect(layoutCss).toMatch(
			/html\[data-reading-pane='below'\][\s\S]*list-pane:has\(\+ \.thread-pane\.has-thread\)\s*\{[\s\S]*display:\s*flex\s*!important/
		);
	});

	test('thread container fills the pane instead of collapsing with height: 100%', () => {
		expect(splitView).toMatch(/\.thread-container\s*\{[^}]*flex:\s*1/s);
		expect(splitView).toMatch(/\.thread-container\s*\{[^}]*min-height:\s*0/s);
		expect(splitView).toMatch(/\.split-layout\s*\{[^}]*min-height:\s*0/s);
	});
});
