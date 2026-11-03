export function isImageType(contentType: string): boolean {
	return contentType.startsWith('image/');
}

export function isMarkdownAttachment(file: { filename: string; content_type: string }): boolean {
	const name = file.filename.toLowerCase();
	if (name.endsWith('.md') || name.endsWith('.markdown') || name.endsWith('.mdown')) {
		return true;
	}

	const type = file.content_type.toLowerCase().split(';')[0]?.trim() ?? '';
	return type === 'text/markdown' || type === 'text/x-markdown';
}

// Types a browser can show without running anything. HTML, SVG, and XML are
// left off: opened on the app's origin, their scripts would run as the user.
const INLINE_TYPES = new Set([
	'image/png',
	'image/jpeg',
	'image/gif',
	'image/webp',
	'image/avif',
	'image/bmp',
	'application/pdf',
	'text/plain',
	'text/csv',
	'application/json'
]);

/** The bare media type, lowercased, without parameters such as charset. */
export function mediaType(contentType: string): string {
	return contentType.toLowerCase().split(';')[0]?.trim() ?? '';
}

export function isPreviewableInline(contentType: string): boolean {
	return INLINE_TYPES.has(mediaType(contentType));
}

export function attachmentHref(emailId: string, attachmentId: string, download = false): string {
	const base = `/api/mail/${emailId}/attachments/${attachmentId}`;
	return download ? `${base}?download=1` : base;
}

export function attachmentIcon(contentType: string): string {
	if (isImageType(contentType)) return 'image-line';
	if (contentType === 'application/pdf') return 'file-pdf-line';
	if (contentType.startsWith('text/')) return 'file-text-line';
	if (contentType.includes('zip') || contentType.includes('compressed')) return 'file-zip-line';
	return 'file-3-line';
}
