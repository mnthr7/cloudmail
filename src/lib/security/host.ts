/**
 * A cheap guess at the organization's domain: the last two labels. Wrong under
 * multi-label or shared suffixes (victim.co.uk and attacker.co.uk both give
 * "co.uk"), so it is only for browser-side hints that must stay small. Anything
 * that decides a verdict uses `organizationDomain` (organization.ts), which reads
 * the Public Suffix List.
 */
export function registrableDomain(host: string): string {
	let value = host.trim().toLowerCase().replace(/\.$/, '');
	if (value.startsWith('www.')) value = value.slice(4);
	const labels = value.split('.').filter(Boolean);
	if (labels.length < 2) return labels.join('.');
	return labels.slice(-2).join('.');
}

export function oneEditAway(left: string, right: string): boolean {
	if (left === right) return false;
	const gap = left.length - right.length;
	if (Math.abs(gap) > 1) return false;
	let i = 0;
	let j = 0;
	let edits = 0;
	while (i < left.length && j < right.length) {
		if (left[i] === right[j]) {
			i += 1;
			j += 1;
			continue;
		}
		edits += 1;
		if (edits > 1) return false;
		if (gap === 0) {
			i += 1;
			j += 1;
		} else if (gap > 0) i += 1;
		else j += 1;
	}
	return true;
}

export function mixedScripts(host: string): boolean {
	const scripts = new Set<string>();
	for (const char of host) {
		if (/\p{Script=Latin}/u.test(char)) scripts.add('latin');
		else if (/\p{Script=Cyrillic}/u.test(char)) scripts.add('cyrillic');
		else if (/\p{Script=Greek}/u.test(char)) scripts.add('greek');
	}
	return scripts.size > 1;
}
