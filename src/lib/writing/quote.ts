import { sanitizeEmailHtml } from '../security/email-html';

export type QuoteInput = {
	kind: 'reply' | 'forward';
	from: string;
	to: string | null;
	subject: string;
	createdAt: string;
	html: string | null;
	text: string | null;
	timeZone: string;
	/** Keep remote images. Off unless the sender's images are trusted. */
	remoteImages?: boolean;
};

export function quoteHtml(input: QuoteInput): string {
	const when = formatWhen(input.createdAt, input.timeZone);
	const from = escapeHtml(displayFrom(input.from));
	const body = quoteBody(input.html, input.text, input.remoteImages ?? false);
	if (input.kind === 'forward') {
		const header = [
			`From: ${from}`,
			`Date: ${escapeHtml(when)}`,
			`Subject: ${escapeHtml(input.subject)}`,
			`To: ${escapeHtml(input.to ?? '')}`
		].join('<br>');
		return `<p>${header}</p><blockquote>${body}</blockquote>`;
	}
	return `<p>On ${escapeHtml(when)}, ${from} wrote:</p><blockquote>${body}</blockquote>`;
}

function quoteBody(html: string | null, text: string | null, remoteImages: boolean): string {
	if (html?.trim()) return sanitizeEmailHtml(html, { remoteImages });
	if (!text?.trim()) return '';
	return text
		.split(/\n{2,}/)
		.map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll('\n', '<br>')}</p>`)
		.join('');
}

function displayFrom(from: string): string {
	const named = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
	if (named?.[1]) return `${named[1]} <${named[2]}>`;
	return from.trim();
}

function formatWhen(iso: string, timeZone: string): string {
	const date = new Date(iso);
	const day = new Intl.DateTimeFormat('en-US', {
		timeZone,
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		year: 'numeric'
	}).format(date);
	const time = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hour: 'numeric',
		minute: '2-digit'
	}).format(date);
	return `${day} at ${time}`;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;');
}
