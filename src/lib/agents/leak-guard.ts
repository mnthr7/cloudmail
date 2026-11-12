/**
 * Keeps an agent's instructions out of the mail it sends (demo spec, R16:
 * "Ava never puts the playbook's text in an outgoing email"). The model is
 * told not to, but a convincing email can talk it into quoting its job, so
 * the server checks every send: a reply that repeats a long passage of the
 * job or the system prompt doesn't go out.
 *
 * The comparison is on letters and digits only, with everything else thrown
 * away on both sides: spaces, punctuation, invisible characters, accents. So
 * the result doesn't depend on where word boundaries fall, and a quote can't
 * be hidden by gluing words together, splitting them, or adding separators
 * a reader won't see.
 *
 * Short overlaps are fine and expected ("welcome to book again"). What's
 * refused is a verbatim passage: RUN_CHARS letters in a row, about ten words.
 */

/** Letters and digits in a row, copied from the instructions, that count as quoting them. */
export const RUN_CHARS = 60;

/** Cyrillic and Greek letters that look like Latin ones, so swapping a few doesn't hide a quote. */
const LOOK_ALIKES: Record<string, string> = {
	а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
	і: 'i', ї: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ԛ: 'q', ԝ: 'w', ɡ: 'g',
	α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x'
};

/** The text as one run of lowercase letters and digits, look-alikes folded to Latin. */
function letters(text: string): string {
	return text
		.normalize('NFKD')
		.toLowerCase()
		.replace(/[^\x00-\x7f]/g, (char) => LOOK_ALIKES[char] ?? char)
		.replace(/[^\p{L}\p{N}]/gu, '');
}

/** True when `body` repeats `size` or more consecutive letters of any of `instructions`. */
export function quotesInstructions(body: string, instructions: string[], size = RUN_CHARS): boolean {
	const sent = letters(body);
	if (sent.length < size) return false;
	for (const source of instructions) {
		const own = letters(source);
		// Every window of the instructions, checked against the reply.
		for (let index = 0; index + size <= own.length; index++) {
			if (sent.includes(own.slice(index, index + size))) return true;
		}
	}
	return false;
}
