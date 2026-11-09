/**
 * Preparing a received message for display.
 *
 * Email HTML is not page HTML. It arrives with fixed pixel heights, layout
 * tables, absolutely positioned chips and inline colours that assume a white
 * page — and it was written for a renderer that is not this app. Dropped
 * straight into the document it fights our stylesheet in both directions: our
 * line-height overflows its fixed boxes, its colours ignore our theme.
 *
 * So it is rendered inside its own document instead, and this module builds
 * that document.
 */

/**
 * Was the message laid out, or just written? Anything with a layout is shown
 * as its sender designed it — on white, untouched. Ordinary correspondence is
 * shown in the app's own colours, so a reply reads like part of the thread
 * rather than a sheet of paper dropped into it.
 */
const LAYOUT_MARKERS = [
	/<table[\s>]/i,
	/<style[\s>]/i,
	/\sbgcolor\s*=/i,
	/background(-color)?\s*:\s*(?!\s*(transparent|none|inherit|initial|unset)\b)/i,
	/position\s*:\s*(absolute|fixed)/i,
	/<center[\s>]/i
];

/** Where the sender's own words end and the conversation history begins. */
const QUOTE_BOUNDARY = [
	/<blockquote/i,
	/class\s*=\s*["'][^"']*gmail_quote/i,
	/class\s*=\s*["'][^"']*yahoo_quoted/i,
	/id\s*=\s*["']?appendonsend/i,
	/id\s*=\s*["']?divRplyFwdMsg/i,
	/-{2,}\s*original message/i
];

/**
 * A reply is judged on what its sender wrote, not on what they quoted. Reply to
 * a message containing a designed element and the quote carries that markup
 * along — which would otherwise class every answer in the thread as designed.
 */
function ownContent(html: string): string {
	let cut = html.length;

	for (const marker of QUOTE_BOUNDARY) {
		const match = marker.exec(html);
		if (match && match.index < cut) cut = match.index;
	}

	// A bare forward is all quote and no words; judge it whole.
	return cut > 30 ? html.slice(0, cut) : html;
}

export function isRichHtml(html: string): boolean {
	const own = ownContent(html);
	return LAYOUT_MARKERS.some((marker) => marker.test(own));
}

/**
 * Applies to both modes: sizing, scrolling and the quote toggle — nothing that
 * styles the sender's own elements.
 *
 * A designed message carries its own layout: nested tables with border="0" /
 * cellpadding="0", spacer cells, code blocks styled inline. Presentational
 * attributes lose to *any* stylesheet rule, so a bare `td { border; padding }`
 * here boxed every layout cell of every newsletter. Element-level typography
 * (tables, cells, p, headings, pre/code, blockquote, hr) therefore lives in
 * PROSE_CSS, which only ordinary correspondence and rendered markdown get.
 */
const FRAME_CSS = `
/* The frame is sized to its content from the outside, so percentage heights
   inside would feed back into that measurement. */
html, body { height: auto !important; }
/* A frame paints an opaque white canvas unless the document opts out, which is
   what put a white sheet under plain replies. A transparent background alone is
   not enough: a frame whose colour scheme differs from its embedder's is denied
   transparency and painted in its own scheme instead, so the scheme has to be
   declared in here too — see the dark rule below. */
html { overflow-x: auto; overflow-y: hidden; background: transparent; -webkit-overflow-scrolling: touch; }
html:not([data-theme='dark']) { color-scheme: light; }
body {
	margin: 0;
	font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
	font-size: 15px;
}
.quote-toggle {
	display: inline-flex;
	align-items: center;
	margin: 0.5rem 0;
	padding: 6px 12px;
	min-height: 32px;
	border: 0;
	border-radius: 6px;
	font: inherit;
	font-size: 14px;
	line-height: 1.4;
	letter-spacing: 0.08em;
	cursor: pointer;
	-webkit-tap-highlight-color: transparent;
	touch-action: manipulation;
}
.quote-hidden { display: none !important; }
`;

/**
 * The app's reading typography, for messages that were written rather than
 * laid out: plain HTML replies and rendered markdown (including ASCII box
 * tables). Tables are only decorated inside .table-scroll — the wrapper
 * renderMarkdown puts around the tables it generates — so a layout table that
 * rides along in quoted history is still left as its sender built it.
 */
const PROSE_CSS = `
body {
	line-height: 1.65;
	overflow-wrap: anywhere;
}
p { margin: 0 0 1em; }
/* Tailwind's reset is not in here, but senders still rely on markers. */
ul { list-style: disc outside; margin: 0.5em 0; padding-left: 1.5em; }
ol { list-style: decimal outside; margin: 0.5em 0; padding-left: 1.5em; }
h1, h2, h3, h4, h5, h6 { margin: 1.15em 0 0.45em; font-weight: 650; line-height: 1.3; }
h1 { font-size: 1.5em; }
h2 { font-size: 1.28em; }
h3 { font-size: 1.12em; }
h4, h5, h6 { font-size: 1em; }
blockquote {
	margin: 0.75em 0;
	padding: 0 0 0 1em;
	border-left: 3px solid rgba(0, 0, 0, 0.12);
}
code {
	font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
	font-size: 0.9em;
	padding: 0.12em 0.35em;
	border-radius: 4px;
	background: rgba(0, 0, 0, 0.06);
}
/* Leftover code blocks keep their columns and scroll sideways instead of
   wrapping each line on a narrow phone viewport. A wrapper is required:
   overflow-x on <pre> alone does not create a finger-scrollable box inside
   a height-sized iframe on iOS. */
pre { white-space: pre; overflow-x: auto; -webkit-overflow-scrolling: touch; max-width: 100%; margin: 0.75em 0; padding: 0.75em 1em; border-radius: 8px; background: rgba(0, 0, 0, 0.06); }
pre code { padding: 0; background: none; }
.pre-scroll {
	overflow-x: auto;
	-webkit-overflow-scrolling: touch;
	max-width: 100%;
	margin: 0.75em 0;
	overscroll-behavior-x: contain;
}
.pre-scroll pre {
	display: block;
	width: max-content;
	min-width: 100%;
	max-width: none;
	margin: 0;
	overflow: visible;
}
.table-scroll {
	overflow-x: auto;
	-webkit-overflow-scrolling: touch;
	max-width: 100%;
	margin: 0.75em 0;
	overscroll-behavior-x: contain;
}
.table-scroll table { border-collapse: collapse; max-width: none; width: max-content; margin: 0; }
.table-scroll th,
.table-scroll td { border: 1px solid rgba(0, 0, 0, 0.12); padding: 0.4em 0.7em; white-space: nowrap; }
.table-scroll th { font-weight: 600; }
.table-scroll caption {
	caption-side: top;
	text-align: left;
	font-weight: 650;
	padding: 0 0 0.4em;
	white-space: normal;
}
hr { border: 0; border-top: 1px solid rgba(0, 0, 0, 0.12); margin: 1.25em 0; }
`;

/** Ordinary correspondence: the app's colours, the app's background. */
const SIMPLE_CSS = `
/* Constrain the iframe document so wide <pre>/tables scroll inside their
   wrappers. iOS does not expose document-level overflow-x on a height-sized iframe. */
html, body { max-width: 100%; overflow-x: hidden; }
body { color: #525252; background: transparent; }
img, video, svg { max-width: 100%; height: auto; }
table { max-width: 100%; }
a { color: #4f6b58; }
blockquote { border-color: rgba(0, 0, 0, 0.12) !important; }
.quote-toggle { color: #525252; background: #f0f0f0; }
.quote-toggle:hover { background: #e6e6e6; }

/*
 * Dark mode. A message written on a white page carries near-black text, which
 * has to give way to the theme's own or it is unreadable here. Inline styles
 * outrank stylesheets, hence !important.
 */
:root[data-theme='dark'] { color-scheme: dark; }
:root[data-theme='dark'] body { color: #a8a8b3 !important; background-color: transparent !important; }
:root[data-theme='dark'] body *:not(a):not(.quote-toggle):not(pre):not(code) {
	color: inherit !important;
	background-color: transparent !important;
	background-image: none !important;
}
:root[data-theme='dark'] pre,
:root[data-theme='dark'] :not(pre) > code {
	background: rgba(255, 255, 255, 0.08);
}
:root[data-theme='dark'] .table-scroll th,
:root[data-theme='dark'] .table-scroll td,
:root[data-theme='dark'] hr,
:root[data-theme='dark'] blockquote {
	border-color: rgba(255, 255, 255, 0.16);
}
:root[data-theme='dark'] a { color: #a8c2b0 !important; }
:root[data-theme='dark'] blockquote { border-color: rgba(255, 255, 255, 0.16) !important; }
:root[data-theme='dark'] .quote-toggle { color: #a8a8b3; background: #2b2b31; }
:root[data-theme='dark'] .quote-toggle:hover { background: #3a3a42; }
`;

/**
 * A designed message renders on the white page it was built for, in either
 * theme — the same thing Gmail does. Recolouring its parts one by one loses the
 * relationships between the sender's colours, and inverting the whole rendering
 * does not work either: a body background propagates to the frame's canvas,
 * which is painted outside the filtered element, so the page stays light while
 * its contents flip.
 */
const RICH_CSS = `
/* The card's inset is app chrome, not the sender's page, so a sender's
   body { padding: 0 } reset does not get to remove it. */
body { color: #18181b; background: #ffffff; padding: 18px 20px !important; }
a { color: #1a56db; }
.quote-toggle { color: #52525b; background: #f0f0f0; }
.quote-toggle:hover { background: #e6e6e6; }
`;

/**
 * Reading typography for the paper skins (Ledger, Desk, Notes). The frame's
 * <html data-skin> mirrors the app's, so only written mail picks these up;
 * designed newsletters keep RICH_CSS and the sender's own layout.
 */
const SKIN_CSS = `
:root[data-skin='ledger'] body { font-family: 'IBM Plex Serif', Georgia, serif; font-size: 15.5px; line-height: 1.6; color: #221e17; }
:root[data-skin='ledger'] a { color: #8a5a12; }
:root[data-skin='ledger'] .table-scroll th,
:root[data-skin='ledger'] .table-scroll td { border-color: #e2daca; padding: 0.3em 0.7em; font-family: 'IBM Plex Sans', system-ui, sans-serif; font-size: 13px; }
:root[data-skin='ledger'] .table-scroll th { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: #7c7363; background: #f2ede2; font-weight: 500; text-align: left; }
:root[data-skin='ledger'] code, :root[data-skin='ledger'] pre { font-family: 'IBM Plex Mono', ui-monospace, monospace; background: #f2ede2; border-radius: 3px; }
:root[data-skin='ledger'] .quote-toggle { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 11px; color: #7c7363; background: transparent; border: 1px dashed #a99f8c; border-radius: 2px; min-height: 0; padding: 0 6px; }

:root[data-skin='desk'] body { font-family: Newsreader, Georgia, serif; font-size: 18px; line-height: 1.6; color: #1c1a16; }
:root[data-skin='desk'] a { color: #8a1c1c; }
:root[data-skin='desk'] .table-scroll th,
:root[data-skin='desk'] .table-scroll td { border: 0; border-bottom: 1px solid #e8e1d3; padding: 0.45em 1.2em 0.45em 0; }
:root[data-skin='desk'] .table-scroll th { font-family: 'Instrument Sans', system-ui, sans-serif; font-size: 10.5px; letter-spacing: 0.13em; text-transform: uppercase; color: #7a7366; font-weight: 600; border-bottom: 1px solid #1c1a16; text-align: left; }
:root[data-skin='desk'] blockquote { border-color: #dcd4c4 !important; font-style: italic; }
:root[data-skin='desk'] .quote-toggle { color: #7a7366; background: transparent; border: 1px solid #dcd4c4; border-radius: 9px; min-height: 0; padding: 0 10px; }

:root[data-skin='notes'] body { font-family: Literata, Georgia, serif; font-size: 16px; line-height: 1.75; color: #141414; }
:root[data-skin='notes'] a { color: #141414; text-decoration-color: #d9503f; text-underline-offset: 3px; }
:root[data-skin='notes'] .table-scroll table { border: 1.5px solid #141414; }
:root[data-skin='notes'] .table-scroll th,
:root[data-skin='notes'] .table-scroll td { border: 0; border-bottom: 1px solid #d4cec1; padding: 0.3em 0.9em; font-size: 14px; }
:root[data-skin='notes'] .table-scroll th { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: #fbf9f4; background: #141414; text-align: left; font-weight: 500; }
:root[data-skin='notes'] code, :root[data-skin='notes'] pre { font-family: 'JetBrains Mono', ui-monospace, monospace; }
:root[data-skin='notes'] .quote-toggle { font-family: 'JetBrains Mono', ui-monospace, monospace; color: #141414; background: #fbf9f4; border: 1px solid #141414; border-radius: 0; min-height: 0; padding: 0 8px; }
`;

export function emailCss(rich: boolean): string {
	return FRAME_CSS + (rich ? RICH_CSS : PROSE_CSS + SIMPLE_CSS + SKIN_CSS);
}

/** Senders differ on whether the HTML part is a fragment or a whole document. */
function isFullDocument(html: string): boolean {
	return /<html[\s>]/i.test(html) || /<body[\s>]/i.test(html);
}

export function buildEmailDocument(html: string, options: { rich: boolean }): string {
	// A complete document is left as the sender wrote it — nesting it inside
	// another one drops its <head>, and with it any <style> the layout needs.
	// Its stylesheet is added after load instead.
	if (isFullDocument(html)) return html;

	// `base target=_blank` keeps links from trying to navigate the app, which the
	// sandbox would block outright.
	return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<style>${emailCss(options.rich)}</style>
</head><body>${html}</body></html>`;
}

/**
 * The written-mail stylesheet aimed at a shadow root instead of a frame
 * document: `:host` stands in for <html> (it carries data-theme and data-skin)
 * and `.root` for <body>.
 */
export function shadowEmailCss(): string {
	const css = (FRAME_CSS + PROSE_CSS + SIMPLE_CSS + SKIN_CSS)
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/:root\[([^\]]+)\]/g, ':host([$1])')
		.replace(/\bhtml:not\((\[[^\]]+\])\)/g, ':host(:not($1))')
		.replace(/\bhtml, body\b/g, '.root')
		.replace(/\bhtml(?=\s*\{)/g, '.root')
		.replace(/\bbody(?=\s*[{*])/g, '.root');
	return `:host { display: block; }\n${css}`;
}
