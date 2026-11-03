<script lang="ts">
	import Icon from './Icon.svelte';
	import {
		imageFilesFromDataTransfer,
		insertImage,
		insertPlainText,
		macPasteArmed,
		textFromDataTransfer
	} from '$lib/utils/editor-paste';
	import { clampDragWidth, widthForPreset, type ImageSizePreset } from '$lib/utils/image-size';
	import { EDITOR_COMMANDS, type EditorCommand } from '$lib/writing/editor-commands';
	import { sanitizeEmailHtml } from '$lib/security/email-html';

	let {
		html = $bindable(''),
		placeholder = 'Write your message…',
		minHeight = 240,
		embedded = false
	}: {
		html?: string;
		placeholder?: string;
		minHeight?: number;
		embedded?: boolean;
	} = $props();

	let editor = $state<HTMLDivElement | null>(null);
	let shell = $state<HTMLDivElement | null>(null);
	let chrome = $state<HTMLDivElement | null>(null);
	let selected = $state<HTMLImageElement | null>(null);
	let frame = $state<{ top: number; left: number; width: number; height: number } | null>(null);
	let altOpen = $state(false);
	let altDraft = $state('');
	let altInput = $state<HTMLInputElement | null>(null);
	let sizeMark = $state(0);
	let menuAbove = $state(false);
	let menuAlignEnd = $state(false);

	function portal(node: HTMLElement) {
		document.body.appendChild(node);
		return {
			destroy() {
				node.remove();
			}
		};
	}

	const activeSize = $derived.by(() => {
		void sizeMark;
		const size = selected?.dataset.qmSize;
		return size === 'small' || size === 'best' || size === 'original' ? size : '';
	});

	function exec(command: string, value?: string) {
		editor?.focus();
		document.execCommand(command, false, value);
		html = editor?.innerHTML ?? '';
	}

	function handleInput() {
		html = editor?.innerHTML ?? '';
	}

	function contentBoxWidth(): number {
		if (!editor) return 0;
		const style = getComputedStyle(editor);
		return editor.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
	}

	function placeChrome() {
		if (!selected || !shell || !selected.isConnected) {
			frame = null;
			if (selected && !selected.isConnected) selected = null;
			return;
		}
		const image = selected.getBoundingClientRect();
		const host = shell.getBoundingClientRect();
		const visible =
			image.bottom > host.top &&
			image.top < host.bottom &&
			image.right > host.left &&
			image.left < host.right &&
			image.width > 0;
		frame = visible
			? { top: image.top, left: image.left, width: image.width, height: image.height }
			: null;
		menuAbove = image.bottom + 40 > window.innerHeight;
		menuAlignEnd = image.left + 440 > window.innerWidth;
	}

	function selectImage(image: HTMLImageElement) {
		selected = image;
		altOpen = false;
		altDraft = image.alt;
		sizeMark += 1;
		queueMicrotask(placeChrome);
	}

	function writeWidth(image: HTMLImageElement, width: number, preset: ImageSizePreset | 'custom') {
		image.dataset.qmSize = preset;
		image.style.width = `${width}px`;
		image.style.height = 'auto';
		image.setAttribute('width', String(width));
		image.removeAttribute('height');
		sizeMark += 1;
		handleInput();
		requestAnimationFrame(placeChrome);
	}

	function applyPreset(preset: ImageSizePreset) {
		const image = selected;
		if (!image) return;
		writeWidth(image, widthForPreset(preset, image.naturalWidth, contentBoxWidth()), preset);
	}

	function removeImage() {
		selected?.remove();
		selected = null;
		frame = null;
		altOpen = false;
		handleInput();
	}

	function saveAlt() {
		if (!selected) return;
		selected.alt = altDraft.trim();
		altOpen = false;
		handleInput();
	}

	function onEditorPointerDown(event: PointerEvent) {
		const target = event.target;
		if (target instanceof HTMLImageElement && editor?.contains(target)) {
			selectImage(target);
			return;
		}
		if (editor?.contains(target as Node)) selected = null;
	}

	function onEditorKeydown(event: KeyboardEvent) {
		if (!selected || altOpen) return;
		if (event.key === 'Escape') {
			selected = null;
			return;
		}
		if (event.key === 'Backspace' || event.key === 'Delete') {
			event.preventDefault();
			removeImage();
		}
	}

	function startDrag(event: PointerEvent, edge: 'left' | 'right') {
		const image = selected;
		if (!image) return;
		event.preventDefault();
		event.stopPropagation();
		const startX = event.clientX;
		const startWidth = image.getBoundingClientRect().width;
		const handle = event.currentTarget as HTMLElement;
		try {
			handle.setPointerCapture(event.pointerId);
		} catch {
			// The pointer can already be gone; dragging still follows pointermove.
		}

		const move = (ev: PointerEvent) => {
			const delta = ev.clientX - startX;
			const next = edge === 'right' ? startWidth + delta : startWidth - delta;
			const width = clampDragWidth(next, contentBoxWidth());
			image.dataset.qmSize = 'custom';
			image.style.width = `${width}px`;
			image.style.height = 'auto';
			image.setAttribute('width', String(width));
			image.removeAttribute('height');
			sizeMark += 1;
			placeChrome();
		};
		const up = () => {
			handle.removeEventListener('pointermove', move);
			handle.removeEventListener('pointerup', up);
			handleInput();
			placeChrome();
		};
		handle.addEventListener('pointermove', move);
		handle.addEventListener('pointerup', up);
	}

	// Parent composers set html (a quote, a signature swap). Typing already
	// writes the same string back, so this only paints an outside change.
	$effect(() => {
		const next = html;
		const node = editor;
		if (!node || node.innerHTML === next) return;
		node.innerHTML = sanitizeEmailHtml(next);
	});

	$effect(() => {
		if (altOpen) altInput?.focus();
	});

	$effect(() => {
		if (!selected) return;
		const onScroll = () => placeChrome();
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (!target || !selected) return;
			if (chrome?.contains(target) || target === selected) return;
			selected = null;
		};
		window.addEventListener('scroll', onScroll, true);
		window.addEventListener('resize', onScroll);
		window.addEventListener('pointerdown', onPointerDown);
		return () => {
			window.removeEventListener('scroll', onScroll, true);
			window.removeEventListener('resize', onScroll);
			window.removeEventListener('pointerdown', onPointerDown);
		};
	});

	function handlePaste(event: ClipboardEvent) {
		if (macPasteArmed()) {
			event.preventDefault();
			return;
		}
		const data = event.clipboardData;
		const text = textFromDataTransfer(data);
		const images = imageFilesFromDataTransfer(data);
		if (!text && images.length === 0) return;
		if (!editor) return;

		// execCommand('insertText') is ignored during paste, so the old handler
		// cancelled the browser paste and then inserted nothing.
		event.preventDefault();
		if (text) insertPlainText(editor, text);
		handleInput();

		for (const file of images) {
			const reader = new FileReader();
			reader.onload = () => {
				if (!editor || typeof reader.result !== 'string') return;
				insertImage(editor, reader.result);
				handleInput();
			};
			reader.readAsDataURL(file);
		}
	}

	const ICONS: Record<string, string> = {
		Bold: 'bold',
		Italic: 'italic',
		Underline: 'underline',
		Strikethrough: 'strikethrough',
		Link: 'link',
		'Bulleted list': 'list-unordered',
		'Numbered list': 'list-ordered',
		Quote: 'double-quotes-l',
		'Align left': 'align-left',
		'Align center': 'align-center',
		'Align right': 'align-right',
		Indent: 'indent-increase',
		Outdent: 'indent-decrease',
		'Clear color': 'eraser-line'
	};

	function handleCommand(command: EditorCommand) {
		if (command.command === 'createLink') {
			const url = window.prompt('Link URL');
			if (url) exec(command.command, url);
			return;
		}
		if (command.command === 'foreColor' && command.value === 'inherit') {
			editor?.focus();
			document.execCommand('styleWithCSS', false, 'true');
			exec(command.command, command.value);
			document.execCommand('styleWithCSS', false, 'false');
			return;
		}
		exec(command.command, command.value);
	}
</script>

<div class="editor-shell" class:editor-shell-embedded={embedded} bind:this={shell}>
	<div class="toolbar" role="toolbar" aria-label="Formatting">
		{#each EDITOR_COMMANDS as command (command.label)}
			{@const icon = ICONS[command.label]}
			<button
				type="button"
				class="icon-btn"
				class:tool-label={!icon && command.command !== 'foreColor'}
				title={command.label}
				aria-label={command.label}
				onclick={() => handleCommand(command)}
			>
				{#if icon}
					<Icon name={icon} size={16} />
				{:else if command.command === 'foreColor' && command.value}
					<span class="swatch-dot" style="background: {command.value}"></span>
				{:else}
					{command.label}
				{/if}
			</button>
		{/each}
	</div>

	<div
		bind:this={editor}
		contenteditable="true"
		role="textbox"
		tabindex="0"
		aria-multiline="true"
		class="editor prose prose-sm max-w-none px-4 py-3 outline-none"
		style="min-height: {minHeight}px"
		data-placeholder={placeholder}
		oninput={handleInput}
		onpaste={handlePaste}
		onpointerdown={onEditorPointerDown}
		onkeydown={onEditorKeydown}
	></div>
</div>

{#if selected && frame}
	<div
		class="image-frame"
		style="top: {frame.top}px; left: {frame.left}px; width: {frame.width}px; height: {frame.height}px"
		bind:this={chrome}
		use:portal
	>
		<button
			type="button"
			class="handle nw"
			aria-label="Resize image"
			onpointerdown={(event) => startDrag(event, 'left')}
		></button>
		<button
			type="button"
			class="handle ne"
			aria-label="Resize image"
			onpointerdown={(event) => startDrag(event, 'right')}
		></button>
		<button
			type="button"
			class="handle sw"
			aria-label="Resize image"
			onpointerdown={(event) => startDrag(event, 'left')}
		></button>
		<button
			type="button"
			class="handle se"
			aria-label="Resize image"
			onpointerdown={(event) => startDrag(event, 'right')}
		></button>

		<div
			class="image-menu"
			class:above={menuAbove}
			class:align-end={menuAlignEnd}
			role="toolbar"
			aria-label="Image size"
		>
			{#if altOpen}
				<input
					class="alt-input"
					bind:this={altInput}
					bind:value={altDraft}
					placeholder="Describe the image"
					aria-label="Image description"
					onkeydown={(event) => {
						if (event.key === 'Enter') {
							event.preventDefault();
							saveAlt();
						} else if (event.key === 'Escape') {
							event.preventDefault();
							altOpen = false;
						}
					}}
				/>
				<button type="button" class="menu-btn" onclick={saveAlt}>Done</button>
			{:else}
				<button
					type="button"
					class="menu-btn"
					class:active={activeSize === 'small'}
					onclick={() => applyPreset('small')}
				>
					Small
				</button>
				<span class="sep" aria-hidden="true">|</span>
				<button
					type="button"
					class="menu-btn"
					class:active={activeSize === 'best'}
					onclick={() => applyPreset('best')}
				>
					Best fit
				</button>
				<span class="sep" aria-hidden="true">|</span>
				<button
					type="button"
					class="menu-btn"
					class:active={activeSize === 'original'}
					onclick={() => applyPreset('original')}
				>
					Original size
				</button>
				<span class="sep" aria-hidden="true">|</span>
				<button
					type="button"
					class="menu-btn"
					onclick={() => {
						altDraft = selected?.alt ?? '';
						altOpen = true;
					}}
				>
					Edit alt text
				</button>
				<span class="sep" aria-hidden="true">|</span>
				<button type="button" class="menu-btn" onclick={removeImage}>Remove</button>
			{/if}
		</div>
	</div>
{/if}

<style>
	.editor-shell {
		position: relative;
		overflow: visible;
		background: var(--color-surface);
		border-radius: 1rem;
		box-shadow: var(--shadow-sm);
	}

	.editor-shell-embedded {
		border-radius: 0;
		box-shadow: none;
		background: transparent;
	}

	.editor-shell-embedded .toolbar {
		padding-left: 0;
		padding-right: 0;
	}

	.editor-shell-embedded .editor {
		padding-left: 0;
		padding-right: 0;
	}

	.toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.125rem;
		padding: 0.375rem 0.5rem;
	}

	.toolbar :global(.icon-btn) {
		width: 2rem;
		height: 2rem;
		flex: none;
	}

	.toolbar :global(.icon-btn.tool-label) {
		width: auto;
		padding: 0 0.45rem;
		border-radius: 999px;
		font-size: 0.75rem;
		line-height: 1;
	}

	.swatch-dot {
		width: 0.7rem;
		height: 0.7rem;
		border-radius: 999px;
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-text) 25%, transparent);
	}

	.editor {
		color: var(--color-text);
		overflow-x: auto;
	}

	.editor:empty::before {
		content: attr(data-placeholder);
		color: var(--color-muted);
		pointer-events: none;
	}

	.editor :global(p) {
		margin: 0 0 0.75em;
	}

	.editor :global(p:last-child) {
		margin-bottom: 0;
	}

	/* Tailwind's reset drops list markers, so a bulleted list typed here would
	   otherwise look like plain paragraphs. */
	.editor :global(ul) {
		list-style: disc outside;
		margin: 0.5em 0;
		padding-left: 1.5em;
	}

	.editor :global(ol) {
		list-style: decimal outside;
		margin: 0.5em 0;
		padding-left: 1.5em;
	}

	.editor :global(li) {
		margin: 0.15em 0;
	}

	.editor :global(a) {
		color: var(--color-accent-text);
		text-decoration: underline;
	}

	.editor :global(img) {
		display: block;
		max-width: 100%;
		height: auto;
		margin: 0.5em 0;
		cursor: pointer;
	}

	.editor :global(img[data-qm-size='original']) {
		max-width: none;
	}

	.image-frame {
		position: fixed;
		z-index: 400;
		pointer-events: none;
		outline: 1px solid var(--color-link);
		outline-offset: 0;
	}

	.handle {
		position: absolute;
		width: 11px;
		height: 11px;
		padding: 0;
		pointer-events: auto;
		background: var(--color-link);
		border: 1px solid #fff;
		border-radius: 1px;
	}

	.handle.nw {
		top: -5px;
		left: -5px;
		cursor: nwse-resize;
	}

	.handle.ne {
		top: -5px;
		right: -5px;
		cursor: nesw-resize;
	}

	.handle.sw {
		bottom: -5px;
		left: -5px;
		cursor: nesw-resize;
	}

	.handle.se {
		bottom: -5px;
		right: -5px;
		cursor: nwse-resize;
	}

	.image-menu {
		position: absolute;
		top: calc(100% - 1px);
		left: -1px;
		display: flex;
		align-items: center;
		gap: 0.35rem;
		width: max-content;
		max-width: min(28rem, 80vw);
		padding: 0.2rem 0.45rem;
		pointer-events: auto;
		background: var(--color-surface);
		border: 1px solid var(--color-line);
		box-shadow: var(--shadow-xs);
	}

	.image-menu.above {
		top: auto;
		bottom: calc(100% - 1px);
	}

	.image-menu.align-end {
		left: auto;
		right: -1px;
	}

	.menu-btn {
		padding: 0;
		font-size: 0.8125rem;
		line-height: 1.4;
		color: var(--color-link);
		background: transparent;
		white-space: nowrap;
	}

	.menu-btn:hover,
	.menu-btn.active {
		text-decoration: underline;
	}

	.sep {
		color: var(--color-muted);
		font-size: 0.75rem;
	}

	.alt-input {
		width: 12rem;
		max-width: 50vw;
		padding: 0.1rem 0.25rem;
		font-size: 0.8125rem;
		color: var(--color-text);
		background: transparent;
		border: none;
		outline: none;
	}
</style>
