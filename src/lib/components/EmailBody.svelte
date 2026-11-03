<script lang="ts">
	import { buildEmailDocument, emailCss, isRichHtml } from '$lib/utils/email-html';
	import { foldQuotedHtml } from '$lib/utils/quotes';
	import { SKIN_FONTS, isSkin } from '$lib/skin';
	import { holdRemoteImages } from '$lib/security/images';
	import { linkWarning } from '$lib/security/links';
	import LinkWarning from './LinkWarning.svelte';

	const STYLE_ID = '__mail-frame-style';

	let {
		html,
		rich: richOverride,
		foldQuotes = true,
		onBlank,
		allowImages = true,
		fromHeader = '',
		onHeld
	}: {
		html: string;
		/** Skip layout detection — markdown is ordinary correspondence, not a designed page. */
		rich?: boolean;
		/** HTML mail folds quoted history inside the frame. Markdown keeps its own toggle. */
		foldQuotes?: boolean;
		/** Called once if the rendered message turns out to show nothing. */
		onBlank?: () => void;
		/** When false, remote image URLs are held out of the document the frame parses. */
		allowImages?: boolean;
		/** This message's From header. Trust is decided by the parent. */
		fromHeader?: string;
		/** True when remote image URLs were removed from the copy in the frame. */
		onHeld?: (held: boolean) => void;
	} = $props();

	const rich = $derived(richOverride ?? isRichHtml(html));
	const gated = $derived(allowImages ? null : holdRemoteImages(html));
	const srcdoc = $derived(buildEmailDocument(gated ? gated.html : html, { rich }));

	let pendingLink = $state<{ sentence: string; href: string } | null>(null);

	$effect(() => {
		onHeld?.(gated?.held ?? false);
	});

	let frame = $state<HTMLIFrameElement | null>(null);
	let height = $state(0);

	let content: ResizeObserver | null = null;
	let theme: MutationObserver | null = null;

	/**
	 * The frame has no scrollbar of its own; it is sized to its content. Measured
	 * on <body>, never on <html>: the root element's scrollHeight is floored at
	 * the viewport, which here is the height we just set — so it could only ever
	 * grow, never settle back down.
	 */
	function measure() {
		const doc = frame?.contentDocument;
		if (!doc?.body) return;

		let body = Math.max(doc.body.scrollHeight, doc.body.offsetHeight);
		// A sender's `body { height: 0 }` or all-floated layout leaves <body>
		// collapsed while its content hangs outside; take the document instead.
		if (body < 24 && (doc.body.innerText ?? '').trim()) {
			body = Math.max(body, doc.documentElement.scrollHeight);
		}
		const next = Math.ceil(body || doc.documentElement.scrollHeight);
		if (next > 0 && Math.abs(next - height) > 1) height = next;
	}

	function syncTheme() {
		const doc = frame?.contentDocument;
		if (!doc) return;
		doc.documentElement.dataset.theme = document.documentElement.dataset.theme ?? 'light';

		// Written mail (not designed newsletters) is set in the skin's reading face.
		const skin = document.documentElement.dataset.skin;
		doc.documentElement.dataset.skin = skin ?? 'classic';
		if (rich || !isSkin(skin) || skin === 'classic') return;
		const head = doc.head ?? doc.documentElement;
		let link = doc.getElementById('__mail-skin-font') as HTMLLinkElement | null;
		if (!link) {
			link = doc.createElement('link');
			link.id = '__mail-skin-font';
			link.rel = 'stylesheet';
			head.appendChild(link);
		}
		if (link.getAttribute('href') !== SKIN_FONTS[skin]) {
			link.href = SKIN_FONTS[skin];
			link.addEventListener('load', () => requestAnimationFrame(measure), { once: true });
		}
	}

	/**
	 * The frame is same-origin but scriptless — `sandbox` withholds
	 * allow-scripts — so everything the message needs is done from out here.
	 */
	/**
	 * Messages that arrived as a whole document get our rules added after load.
	 * They go in *first*, ahead of the sender's own style sheet, so that where the
	 * two tie the sender's layout wins — ours are defaults, not overrides.
	 */
	function applyStyles(doc: Document) {
		if (doc.getElementById(STYLE_ID)) return;

		const style = doc.createElement('style');
		style.id = STYLE_ID;
		style.textContent = emailCss(rich);
		const head = doc.head ?? doc.documentElement;
		head.insertBefore(style, head.firstChild);

		// Without a <base> of ours, a link would try to navigate this frame — which
		// the sandbox blocks, so the click would simply do nothing.
		for (const link of Array.from(doc.links)) {
			link.setAttribute('target', '_blank');
			link.setAttribute('rel', 'noopener noreferrer');
		}
	}

	let blankReported = false;

	/** Visible words, or a visible image / embed. innerText skips display:none. */
	function showsAnything(doc: Document): boolean {
		const text = (doc.body.innerText ?? doc.body.textContent ?? '')
			.replace(/[\s\u00a0\u200b-\u200f\u2060\u034f\ufeff\u00ad]+/g, '');
		if (text) return true;
		const media = Array.from(doc.body.querySelectorAll('img, video, svg, canvas, iframe, object, embed'));
		return media.some((el) => {
			const box = (el as HTMLElement).getBoundingClientRect();
			return box.width > 2 && box.height > 2;
		});
	}

	function checkBlank() {
		if (blankReported || !onBlank) return;
		// A message that is only remote images looks empty while those URLs are held.
		if (gated?.held) return;
		const doc = frame?.contentDocument;
		if (!doc?.body) return;
		if (!showsAnything(doc)) {
			blankReported = true;
			onBlank();
		}
	}

	/**
	 * The anchor belongs to the frame document, so it is not this window's
	 * HTMLAnchorElement. tagName is the check that still sees it.
	 */
	function onFrameClick(event: MouseEvent) {
		const target = event.target;
		// Frame nodes are not this window's Element, so instanceof would miss every click.
		if (!target || typeof target !== 'object' || !('nodeType' in target)) return;
		const node = target as Node;
		const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
		const anchor = element?.closest('a');
		if (!anchor || anchor.tagName !== 'A') return;

		const link = anchor as HTMLAnchorElement;
		const protocol = link.protocol.toLowerCase();
		if (protocol !== 'http:' && protocol !== 'https:' && protocol !== 'mailto:') return;

		const sentence = linkWarning(link.textContent ?? '', link.href);
		if (!sentence) return;

		event.preventDefault();
		event.stopPropagation();
		pendingLink = { sentence, href: link.href };
	}

	function onLoad() {
		const doc = frame?.contentDocument;
		if (!doc?.body) return;

		applyStyles(doc);
		// The effect and the load timer both call onLoad for one document.
		doc.removeEventListener('click', onFrameClick);
		doc.addEventListener('click', onFrameClick);
		syncTheme();
		if (foldQuotes) foldQuotedHtml(doc.body);
		measure();

		// When the quote toggle is clicked inside the iframe, force a re-measurement.
		// The ResizeObserver should catch this, but mobile Safari sometimes needs a nudge.
		doc.body.addEventListener(
			'quote-toggled',
			() => {
				// Give the browser a frame to finish the layout update.
				requestAnimationFrame(() => {
					requestAnimationFrame(measure);
				});
			},
			{ passive: true }
		);

		// Images settle after load and change the height with them.
		for (const image of Array.from(doc.images)) {
			if (image.complete) continue;
			image.addEventListener('load', measure, { once: true });
			image.addEventListener('error', measure, { once: true });
		}

		content?.disconnect();
		content = new ResizeObserver(measure);
		content.observe(doc.body);

		theme?.disconnect();
		theme = new MutationObserver(syncTheme);
		theme.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['data-theme', 'data-skin']
		});
	}

	/**
	 * A srcdoc frame can finish loading before this component hydrates, in which
	 * case its load event is already gone and nothing would ever size it. The
	 * timer is the backstop: a message that resists measurement is shown at a
	 * readable height and left to scroll rather than hidden.
	 */
	$effect(() => {
		void srcdoc;
		blankReported = false;

		const doc = frame?.contentDocument;
		if (doc?.readyState === 'complete' && doc.body?.hasChildNodes()) onLoad();

		const blankTimer = setTimeout(checkBlank, 1200);
		const timer = setTimeout(() => {
			// onLoad is idempotent, and reaching here without it having run would
			// reveal an unstyled, light-schemed frame.
			onLoad();
			measure();
			if (height === 0) {
				const document_ = frame?.contentDocument;
				if (document_) document_.documentElement.style.overflowY = 'auto';
				height = 360;
			}
		}, 700);

		return () => {
			clearTimeout(timer);
			clearTimeout(blankTimer);
		};
	});

	$effect(() => () => {
		content?.disconnect();
		theme?.disconnect();
	});
</script>

<iframe
	bind:this={frame}
	class="frame"
	class:rich
	class:sized={height > 0}
	title="Message content"
	sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
	referrerpolicy="no-referrer"
	{srcdoc}
	onload={onLoad}
	style:height={height ? `${height}px` : undefined}
></iframe>

{#if pendingLink}
	<LinkWarning
		sentence={pendingLink.sentence}
		href={pendingLink.href}
		onOpen={() => (pendingLink = null)}
		onCancel={() => (pendingLink = null)}
	/>
{/if}

<style>
	.frame {
		display: block;
		width: 100%;
		min-height: 1.5rem;
		border: 0;
		/* Until the first measurement lands the height is a guess; hide the jump. */
		opacity: 0;
	}

	.frame.sized {
		opacity: 1;
		transition: opacity 0.12s;
	}

	/* A designed message sits on the white page it was built for, so give it a
	   card to sit on — in both themes. */
	.frame.rich {
		border-radius: 0.75rem;
		background: #ffffff;
	}
</style>
