/**
 * Keeps an agent's instructions out of the mail it sends (demo spec, R16:
 * "Ava never puts the playbook's text in an outgoing email"). The model is
 * told not to, but a convincing email can talk it into quoting its job, so
 * the server checks every send: a reply that repeats a long run of words from
 * the job or the system prompt doesn't go out.
 *
 * Short overlaps are fine and expected ("welcome to book again"). What's
 * refused is a verbatim passage: RUN_WORDS or more words in a row.
 */

/** Words in a row, copied from the instructions, that count as quoting them. */
export const RUN_WORDS = 10;

/** Cyrillic and Greek letters that look like Latin ones, so swapping a few doesn't hide a quote. */
const LOOK_ALIKES: Record<string, string> = {
	а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
	і: 'i', ї: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ԛ: 'q', ԝ: 'w', ɡ: 'g',
	α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x'
};

function words(text: string): string[] {
	return text
		.normalize('NFKC')
		// Invisible format characters (zero-width spaces and joiners, soft hyphens, bidi marks) and
		// combining marks would otherwise split or change words without changing what a reader sees.
		.normalize('NFKD')
		.replace(/[\p{Cf}\p{Mn}­]/gu, '')
		.toLowerCase()
		.replace(/[^\x00-\x7f]/g, (char) => LOOK_ALIKES[char] ?? char)
		.replace(/[‘’]/g, "'")
		.split(/[^\p{L}\p{N}']+/u)
		.map((word) => word.replace(/^'+|'+$/g, ''))
		.filter(Boolean);
}

function runs(list: string[], size: number): Set<string> {
	const out = new Set<string>();
	for (let index = 0; index + size <= list.length; index++) out.add(list.slice(index, index + size).join(' '));
	return out;
}

/** True when `body` repeats RUN_WORDS or more consecutive words of any of `instructions`. */
export function quotesInstructions(body: string, instructions: string[], size = RUN_WORDS): boolean {
	const sent = words(body);
	if (sent.length < size) return false;
	const sentRuns = runs(sent, size);
	for (const source of instructions) {
		for (const run of runs(words(source), size)) if (sentRuns.has(run)) return true;
	}
	return false;
}
