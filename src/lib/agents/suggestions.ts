import { htmlToPlainText } from '#lib/utils/html.ts';

/** A set of suggested replies as the reader shows it. */
export type SuggestionView = {
	id: string;
	agentName: string;
	intent: string;
	replyNeeded: boolean;
	options: Array<{ label: string; body: string }>;
	emailId: string;
	createdAt: string;
};

/** Which suggestion a reply started from, sent along with it. */
export type SuggestionRef = { id: string; index: number };

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Plain-text reply to editor HTML: blank lines make paragraphs, single newlines line breaks. */
export function textToHtml(text: string): string {
	return text
		.trim()
		.split(/\n\s*\n/)
		.map((paragraph) => `<p>${escapeHtml(paragraph.trim()).replace(/\n/g, '<br>')}</p>`)
		.join('');
}

/** Where what the user writes ends: the signature, or else the quoted message. */
function writtenEnd(html: string): number {
	const marks = [html.indexOf('<div data-qm-signature'), html.indexOf('<blockquote')].filter((at) => at !== -1);
	return marks.length ? Math.min(...marks) : -1;
}

/** Puts a suggested reply in the composer, keeping the signature and quote below it. */
export function withSuggestion(composerHtml: string, body: string): string {
	const end = writtenEnd(composerHtml);
	return textToHtml(body) + (end === -1 ? '' : composerHtml.slice(end));
}

/** The text the user wrote, without signature or quote: what a suggestion is compared with. */
export function writtenText(composerHtml: string): string {
	const end = writtenEnd(composerHtml);
	return htmlToPlainText(end === -1 ? composerHtml : composerHtml.slice(0, end));
}
