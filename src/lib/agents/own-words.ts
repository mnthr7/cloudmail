/**
 * What a teammate wrote themselves in a message they forwarded or sent to an
 * agent: everything above the first sign of quoted or forwarded mail. That
 * part is their instruction; everything below it is data (A11).
 *
 * Unlike the reader's quote folding, this never falls back to the whole
 * message: a bare forward with nothing typed above it asks for nothing.
 */

const MARKERS: RegExp[] = [
	// Quoted lines.
	/^>/,
	// Gmail, Outlook and others.
	/^-{2,}\s*(original|forwarded)\s+message\b/i,
	/^-{2,}\s*(original|forwarded)\b.*-{2,}\s*$/i,
	// Apple Mail.
	/^begin forwarded message\s*:/i,
	// Bare separators some clients put above the history.
	/^-{3,}\s*$/,
	/^_{5,}\s*$/,
	/^={5,}\s*$/,
	/^\*{5,}\s*$/,
	// Outlook's and others' header block: "From: …", "Sent: …", "Date: …".
	/^\*?(from|sent|date|to|subject|cc)\s*:\s*\*?\s*\S/i,
	// Localized forwards and replies.
	/^-{2,}.*(weitergeleitete|mensaje reenviado|message transféré|messaggio inoltrato|mensagem encaminhada)/i,
	/^(de|von|da|van)\s*:\s*\S.*@/i
];

/** "On Tue, Jul 28, 2026 at 3:36 AM Someone <a@b> wrote:", possibly wrapped. */
const ATTRIBUTION = /^\s*on\b[\s\S]{0,300}\bwrote:\s*$/i;

export function ownWords(text: string): string {
	const lines = text.replace(/\r\n?/g, '\n').split('\n');
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index].trim();
		const attribution =
			/^on\b/i.test(line) &&
			(ATTRIBUTION.test(line) || ATTRIBUTION.test(`${line} ${(lines[index + 1] ?? '').trim()}`.slice(0, 400)));
		if (attribution || MARKERS.some((marker) => marker.test(line))) {
			return lines.slice(0, index).join('\n').trim();
		}
	}
	return text.trim();
}
