/** Turns clipboard HTML into plain text when the clipboard has no text/plain. */
export function plainTextFromHtml(html: string): string {
	const withBreaks = html
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre)>/gi, '\n');
	const decoded = withBreaks
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/gi, '&');
	return normalizePastedText(decoded);
}

export function normalizePastedText(text: string): string {
	return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function textFromDataTransfer(data: DataTransfer | null): string {
	if (!data) return '';
	const plain = data.getData('text/plain');
	if (plain) return normalizePastedText(plain);
	const html = data.getData('text/html');
	return html ? plainTextFromHtml(html) : '';
}

const RASTER_IMAGE = /^image\/(png|jpeg|gif|webp|bmp)$/;

export function imageFilesFromDataTransfer(data: DataTransfer | null): File[] {
	if (!data) return [];
	const fromList = [...data.files].filter((file) => RASTER_IMAGE.test(file.type));
	if (fromList.length > 0) return fromList;

	const fromItems: File[] = [];
	for (const item of data.items) {
		if (item.kind !== 'file' || !RASTER_IMAGE.test(item.type)) continue;
		const file = item.getAsFile();
		if (file) fromItems.push(file);
	}
	return fromItems;
}

/**
 * Control-V on a Mac does not normally fire `paste`. If a browser does both,
 * ignore that paste so the text is not inserted twice. Cleared before the next
 * task, so Command-V still works immediately after.
 */
let suppressNativePaste = false;

export function armMacPaste() {
	suppressNativePaste = true;
	queueMicrotask(() => {
		suppressNativePaste = false;
	});
}

export function macPasteArmed(): boolean {
	return suppressNativePaste;
}

/** macOS does not treat Control as the clipboard shortcut; Command does. */
export function isMacPlatform(): boolean {
	if (typeof navigator === 'undefined') return false;
	const platform = navigator.platform || '';
	const agent = navigator.userAgent || '';
	return /Mac|iPhone|iPad|iPod/.test(platform) || /Mac OS X/.test(agent);
}

export function selectedPlainText(target: EventTarget | null): string {
	if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
		const start = target.selectionStart ?? 0;
		const end = target.selectionEnd ?? start;
		return target.value.slice(start, end);
	}
	return window.getSelection()?.toString() ?? '';
}

export type PasteSlot =
	| { kind: 'field'; field: HTMLInputElement | HTMLTextAreaElement; start: number; end: number }
	| { kind: 'editor'; root: HTMLElement; range: Range | null };

/** Where a paste should land, captured before an async clipboard read. */
export function capturePasteSlot(target: EventTarget | null): PasteSlot | null {
	if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
		if (target.disabled || target.readOnly) return null;
		const type = target.type;
		if (
			type === 'checkbox' ||
			type === 'radio' ||
			type === 'file' ||
			type === 'button' ||
			type === 'submit' ||
			type === 'range' ||
			type === 'color' ||
			type === 'hidden'
		) {
			return null;
		}
		return {
			kind: 'field',
			field: target,
			start: target.selectionStart ?? target.value.length,
			end: target.selectionEnd ?? target.value.length
		};
	}

	const element = target as HTMLElement | null;
	if (!element?.closest) return null;
	const root = element.isContentEditable
		? element
		: element.closest<HTMLElement>('[contenteditable="true"]');
	if (!root) return null;

	const selection = window.getSelection();
	let range: Range | null = null;
	if (selection && selection.rangeCount > 0 && root.contains(selection.anchorNode)) {
		range = selection.getRangeAt(0).cloneRange();
	}
	return { kind: 'editor', root, range };
}

export function insertPlainText(root: HTMLElement, text: string, saved?: Range | null) {
	const normalized = normalizePastedText(text);
	if (!normalized) return;

	root.focus();
	const selection = window.getSelection();
	if (!selection) return;

	let range = saved && root.contains(saved.commonAncestorContainer) ? saved : null;
	if (!range) {
		if (selection.rangeCount > 0 && root.contains(selection.anchorNode)) {
			range = selection.getRangeAt(0);
		} else {
			range = document.createRange();
			range.selectNodeContents(root);
			range.collapse(false);
		}
	}

	range.deleteContents();
	const fragment = document.createDocumentFragment();
	const lines = normalized.split('\n');
	for (let index = 0; index < lines.length; index += 1) {
		if (index > 0) fragment.append(document.createElement('br'));
		fragment.append(document.createTextNode(lines[index] ?? ''));
	}
	const last = fragment.lastChild;
	range.insertNode(fragment);
	if (last) {
		range.setStartAfter(last);
		range.collapse(true);
	}
	selection.removeAllRanges();
	selection.addRange(range);
}

export function insertImage(root: HTMLElement, src: string) {
	root.focus();
	const selection = window.getSelection();
	if (!selection) return;

	let range: Range;
	if (selection.rangeCount > 0 && root.contains(selection.anchorNode)) {
		range = selection.getRangeAt(0);
	} else {
		range = document.createRange();
		range.selectNodeContents(root);
		range.collapse(false);
	}

	range.deleteContents();
	const image = document.createElement('img');
	image.src = src;
	image.alt = '';
	range.insertNode(image);
	range.setStartAfter(image);
	range.collapse(true);
	selection.removeAllRanges();
	selection.addRange(range);
}

function notifyInput(target: HTMLElement) {
	target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
}

export function applyPaste(slot: PasteSlot, text: string, images: string[] = []) {
	if (slot.kind === 'field') {
		if (!text) return;
		const { field, start, end } = slot;
		field.focus();
		field.setRangeText(text, start, end, 'end');
		notifyInput(field);
		return;
	}

	if (text) insertPlainText(slot.root, text, slot.range);
	for (const src of images) insertImage(slot.root, src);
	if (text || images.length > 0) notifyInput(slot.root);
}

export function deleteSelection(target: EventTarget | null) {
	if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
		const start = target.selectionStart ?? 0;
		const end = target.selectionEnd ?? start;
		if (start === end) return;
		target.setRangeText('', start, end, 'end');
		notifyInput(target);
		return;
	}

	const slot = capturePasteSlot(target);
	if (!slot || slot.kind !== 'editor') return;
	const selection = window.getSelection();
	if (!selection || selection.isCollapsed || !selection.rangeCount) return;
	const range = selection.getRangeAt(0);
	if (!slot.root.contains(range.commonAncestorContainer)) return;
	range.deleteContents();
	notifyInput(slot.root);
}

function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result ?? ''));
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(blob);
	});
}

/** Reads text and images. Used for Control-V on macOS, which does not fire paste. */
export async function readSystemClipboard(): Promise<{ text: string; images: string[] }> {
	try {
		if (navigator.clipboard.read) {
			const items = await navigator.clipboard.read();
			let text = '';
			const images: string[] = [];
			for (const item of items) {
				if (item.types.includes('text/plain')) {
					text += await (await item.getType('text/plain')).text();
				} else if (!text && item.types.includes('text/html')) {
					text = plainTextFromHtml(await (await item.getType('text/html')).text());
				}
				const imageType = item.types.find((type) => RASTER_IMAGE.test(type));
				if (imageType) images.push(await blobToDataUrl(await item.getType(imageType)));
			}
			if (text || images.length > 0) {
				return { text: normalizePastedText(text), images };
			}
		}
	} catch {
		// Fall through to text-only. Some browsers only allow readText().
	}

	try {
		return { text: normalizePastedText(await navigator.clipboard.readText()), images: [] };
	} catch {
		return { text: '', images: [] };
	}
}
