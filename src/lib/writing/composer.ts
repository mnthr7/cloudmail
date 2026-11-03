import { replyRecipients, type ReplyInput } from './recipients';
import { quoteHtml } from './quote';
import { applySignature } from './signature';
import { forwardSubject, replySubject } from './subject';

export type ComposerMode = 'reply' | 'reply-all' | 'forward';

export type ComposerInput = {
	mode: ComposerMode;
	/** Inbound when omitted. Reply then starts from Reply-To or From. */
	direction?: ReplyInput['direction'];
	from: string;
	replyTo: string | null;
	to: string | null;
	cc: string | null;
	bcc: string | null;
	own: string[];
	subject: string;
	createdAt: string;
	html: string | null;
	text: string | null;
	timeZone: string;
	signatureHtml: string | null;
	/** The sender's images are trusted, so the quote may load them. */
	remoteImages?: boolean;
};

export function composerDraft(input: ComposerInput): {
	to: string[];
	subject: string;
	html: string;
	showReplyAll: boolean;
} {
	const sets = replyRecipients({
		direction: input.direction ?? 'inbound',
		from: input.from,
		replyTo: input.replyTo,
		to: input.to,
		cc: input.cc,
		bcc: input.bcc,
		own: input.own
	});
	const to =
		input.mode === 'forward' ? [] : input.mode === 'reply-all' ? sets.replyAll : sets.reply;
	const subject =
		input.mode === 'forward' ? forwardSubject(input.subject) : replySubject(input.subject);
	const html = applySignature(
		// A bare <p></p> collapses, so the caret lands on the quoted line.
		'<p><br></p>' +
			quoteHtml({
				kind: input.mode === 'forward' ? 'forward' : 'reply',
				from: input.from,
				to: input.to,
				subject: input.subject,
				createdAt: input.createdAt,
				html: input.html,
				text: input.text,
				timeZone: input.timeZone,
				remoteImages: input.remoteImages
			}),
		input.signatureHtml
	);
	return { to, subject, html, showReplyAll: sets.showReplyAll };
}
