#!/usr/bin/env node
/**
 * Sorts a pull request into a risk tier from the files it changes.
 *
 *   low:  every file is on the low-risk list below. Once CI passes it can merge
 *         without a human (see .github/workflows/risk-tier.yml).
 *   high: anything else. A human reviews and merges it.
 *
 * The list is an allowlist on purpose: a new file or folder is high risk until
 * someone decides otherwise. CloudMail sends mail as its users and holds their
 * sessions, so a mistake there can't be taken back.
 *
 * CI runs this file from the base branch, never from the pull request, so a
 * pull request can't lower its own tier by editing it.
 *
 * CLI: changed paths on stdin, one per line. Prints JSON: { tier, highRisk }.
 */

/** Files a change can touch and still merge on its own. */
const LOW_RISK = [
	// Words, not code.
	/^docs\//,
	/^[^/]+\.md$/,
	/^\.github\/ISSUE_TEMPLATE\//,
	/^\.github\/pull_request_template\.md$/,
	// Tests can't change what ships.
	/^tests\//,
	// Look and layout.
	/^src\/lib\/components\/[^/]+\.svelte$/,
	/^src\/routes\/(?:.+\/)?\+page\.svelte$/,
	/^src\/routes\/\+layout\.svelte$/,
	/^src\/.+\.css$/,
	/^src\/lib\/skins\//,
	/^src\/lib\/assets\//,
	/^static\//,
	/^\.vscode\//
];

/** Inside the low-risk folders, but they render or edit untrusted mail HTML. */
const ALWAYS_HIGH = [/^src\/lib\/components\/EmailBody\.svelte$/, /^src\/lib\/components\/RichTextEditor\.svelte$/];

/** @param {string} path */
export function isLowRisk(path) {
	if (ALWAYS_HIGH.some((pattern) => pattern.test(path))) return false;
	return LOW_RISK.some((pattern) => pattern.test(path));
}

/**
 * @param {string[]} paths every file the pull request adds, changes, deletes, or renames (both names)
 * @returns {{ tier: 'low' | 'high', highRisk: string[] }}
 */
export function classify(paths) {
	const files = paths.map((path) => path.trim()).filter(Boolean);
	const highRisk = files.filter((path) => !isLowRisk(path));
	// No files listed means we couldn't see the change, so a human looks.
	const tier = files.length > 0 && highRisk.length === 0 ? 'low' : 'high';
	return { tier, highRisk };
}

if (import.meta.main ?? process.argv[1]?.endsWith('risk-tier.mjs')) {
	let input = '';
	for await (const chunk of process.stdin) input += chunk;
	process.stdout.write(`${JSON.stringify(classify(input.split('\n')))}\n`);
}
