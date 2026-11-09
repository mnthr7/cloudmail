import sanitizeHtml from 'sanitize-html';

/**
 * Received mail is shown in a sandboxed iframe, but a reply or forward copies
 * it into the composer, which lives in the app's own document. Anything that
 * goes there passes through this first: formatting stays, script does not.
 */
const NO_URL = /^(?!.*(?:url\s*\(|expression\s*\(|javascript:|@import)).*$/i;
const LENGTH = /^-?[\d.]+(?:px|em|rem|%|pt)?(?:\s+-?[\d.]+(?:px|em|rem|%|pt)?){0,3}$/i;

const STYLES: Record<string, RegExp[]> = Object.fromEntries(
	[
		'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'font-style',
		'text-align', 'text-decoration', 'text-transform', 'line-height', 'letter-spacing',
		'vertical-align', 'white-space', 'border', 'border-top', 'border-right', 'border-bottom',
		'border-left', 'border-color', 'border-style', 'border-width', 'border-collapse',
		'border-radius', 'list-style-type', 'display'
	]
		.map((name): [string, RegExp[]] => [name, [NO_URL]])
		.concat(
			[
				'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
				'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
				'width', 'max-width', 'height', 'text-indent'
			].map((name): [string, RegExp[]] => [name, [LENGTH, /^auto$/i]])
		)
);

const OPTIONS: sanitizeHtml.IOptions = {
	allowedTags: [
		'p', 'br', 'hr', 'div', 'span', 'font', 'center',
		'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
		'ul', 'ol', 'li', 'dl', 'dt', 'dd',
		'strong', 'em', 'b', 'i', 'u', 's', 'strike', 'del', 'ins', 'sub', 'sup', 'small', 'big', 'mark',
		'a', 'img', 'blockquote', 'pre', 'code',
		'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col'
	],
	allowedAttributes: {
		'*': ['style', 'align', 'dir', 'title'],
		a: ['href', 'name'],
		img: ['src', 'alt', 'width', 'height'],
		font: ['color', 'face', 'size'],
		table: ['width', 'border', 'cellpadding', 'cellspacing', 'bgcolor'],
		td: ['width', 'colspan', 'rowspan', 'valign', 'bgcolor'],
		th: ['width', 'colspan', 'rowspan', 'valign', 'bgcolor'],
		col: ['width', 'span'],
		ol: ['start', 'type'],
		li: ['value']
	},
	allowedSchemes: ['http', 'https', 'mailto'],
	allowedSchemesByTag: { img: ['http', 'https', 'data', 'cid'] },
	allowProtocolRelative: false,
	// Only text and box styling survives. Positioning could lay quoted mail over
	// the app's own controls, and url() would fetch from the sender's server.
	allowedStyles: { '*': STYLES },
	disallowedTagsMode: 'discard'
};

/**
 * Only inline sources are safe to show without a fetch. Anything else, however
 * it is spelled, counts as remote. Control characters and whitespace are
 * dropped first, as browsers ignore them inside a URL scheme.
 */
function isInlineImage(src: string): boolean {
	// eslint-disable-next-line no-control-regex
	const compact = src.replace(/[\u0000-\u0020\u007f-\u009f]+/g, '').toLowerCase();
	return compact.startsWith('data:image/') || compact.startsWith('cid:');
}

/**
 * Without `remoteImages`, a remote image becomes a text placeholder, so quoting
 * a message doesn't fetch the sender's tracking pixels behind the image hold.
 */
export function sanitizeEmailHtml(html: string, options: { remoteImages?: boolean } = {}): string {
	if (options.remoteImages ?? true) return sanitizeHtml(html, OPTIONS);
	return sanitizeHtml(html, {
		...OPTIONS,
		transformTags: {
			img: (tagName, attribs) => {
				if (isInlineImage(attribs.src ?? '')) return { tagName, attribs };
				const alt = attribs.alt?.trim();
				return { tagName: 'span', attribs: {}, text: alt ? `[image: ${alt}]` : '[image]' };
			}
		}
	});
}

/**
 * A message shown in the page itself rather than in a frame. Written mail on a
 * phone renders here: iOS WebKit can leave a srcdoc frame inside the thread's
 * scroller unpainted, which showed the header and a blank page below it.
 *
 * Same allow-list as above, plus `class` and `id` — quote folding finds Gmail,
 * Yahoo and Outlook history by them, and rendered markdown wraps its tables in
 * classed scrollers. They can only match the shadow root's own stylesheet. A
 * whole document is cut down to its <body> first, so a <title> never surfaces
 * as text.
 */
export function sanitizeInlineEmailHtml(
	html: string,
	options: { remoteImages?: boolean } = {}
): string {
	const body = /<body[^>]*>([\s\S]*)<\/body\s*>/i.exec(html)?.[1] ?? html;
	const inline: sanitizeHtml.IOptions = {
		...OPTIONS,
		allowedAttributes: {
			...(OPTIONS.allowedAttributes as Record<string, string[]>),
			'*': ['style', 'align', 'dir', 'title', 'class', 'id'],
			blockquote: ['type']
		},
		nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'title', 'head']
	};
	if (options.remoteImages ?? true) return sanitizeHtml(body, inline);
	return sanitizeHtml(body, {
		...inline,
		transformTags: {
			img: (tagName, attribs) => {
				if (isInlineImage(attribs.src ?? '')) return { tagName, attribs };
				const alt = attribs.alt?.trim();
				return { tagName: 'span', attribs: {}, text: alt ? `[image: ${alt}]` : '[image]' };
			}
		}
	});
}
