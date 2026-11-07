#!/usr/bin/env node
/**
 * Sorts a pull request into a risk tier from the files it changes.
 *
 *   low:  every file is on the low-risk list below. Once CI passes it can merge
 *         without a human (see .github/workflows/risk-tier.yml). Only files
 *         that can't run: words, tests, styles, and raster images.
 *   high: anything else. A human reviews and merges it.
 *
 * The list is an allowlist on purpose: a new file or folder is high risk until
 * someone decides otherwise. CloudMail sends mail as its users and holds their
 * sessions, so a mistake there can't be taken back.
 *
 * CI runs this file from the base branch, never from the pull request, so a
 * pull request can't lower its own tier by editing it.
 *
 * Svelte files are code (their scripts run with the signed-in user's access),
 * SVG and HTML can carry script, and static/_headers or _redirects change how
 * the app is served, so none of them are low risk.
 *
 * CLI: changed paths on stdin, one per line. Prints JSON: { tier, highRisk, dependenciesOnly }.
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
	// Styles.
	/^src\/.+\.css$/,
	// Raster images and plain text, which browsers never run.
	/^(?:static|src\/lib\/assets|docs)\/.+\.(?:png|jpe?g|gif|webp|avif|ico)$/,
	/^static\/robots\.txt$/
];

/** What a Dependabot patch or minor update may touch and still merge on its own. */
const DEPENDENCY_MANIFESTS = /^(?:package\.json|bun\.lock|package-lock\.json)$/;

/** @param {string} path */
export function isLowRisk(path) {
	return LOW_RISK.some((pattern) => pattern.test(path));
}

/**
 * @param {string[]} paths every file the pull request adds, changes, deletes, or renames (both names)
 * @returns {{ tier: 'low' | 'high', highRisk: string[], dependenciesOnly: boolean }}
 */
export function classify(paths) {
	const files = paths.map((path) => path.trim()).filter(Boolean);
	const highRisk = files.filter((path) => !isLowRisk(path));
	// No files listed means we couldn't see the change, so a human looks.
	const tier = files.length > 0 && highRisk.length === 0 ? 'low' : 'high';
	const dependenciesOnly = files.length > 0 && files.every((path) => DEPENDENCY_MANIFESTS.test(path));
	return { tier, highRisk, dependenciesOnly };
}

if (import.meta.main ?? process.argv[1]?.endsWith('risk-tier.mjs')) {
	let input = '';
	for await (const chunk of process.stdin) input += chunk;
	process.stdout.write(`${JSON.stringify(classify(input.split('\n')))}\n`);
}
