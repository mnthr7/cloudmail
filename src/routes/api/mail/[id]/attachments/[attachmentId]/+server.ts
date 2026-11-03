import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAttachmentForUser, readAttachmentBytes } from '$lib/server/attachments';
import { isMarkdownAttachment, isPreviewableInline, mediaType } from '$lib/utils/attachments';

export const GET: RequestHandler = async ({ params, locals, platform, url }) => {
	if (!locals.user || !platform?.env.DB || !platform?.env.ATTACHMENTS) {
		throw error(401, 'Unauthorized');
	}

	const attachment = await getAttachmentForUser(
		platform.env.DB,
		locals.user.id,
		params.id,
		params.attachmentId
	);

	if (!attachment) {
		throw error(404, 'Attachment not found');
	}

	const scanStatus = attachment.scan_status ?? 'skipped';
	if (scanStatus === 'pending' || scanStatus === 'infected') {
		return json({ error: scanStatus }, { status: 403 });
	}

	const bytes = await readAttachmentBytes(platform.env.ATTACHMENTS, attachment);
	if (!bytes) {
		throw error(404, 'Attachment not found');
	}

	const forceDownload = url.searchParams.get('download') === '1';
	const markdown = isMarkdownAttachment(attachment);
	const inline =
		!forceDownload && (isPreviewableInline(attachment.content_type) || markdown);

	const body = new Uint8Array(bytes);

	// The sender picks content_type. Only an allowlisted type is echoed back;
	// markdown is shown as plain text and anything else downloads as bytes.
	const type = mediaType(attachment.content_type);
	const contentType = !inline
		? 'application/octet-stream'
		: markdown
			? 'text/plain; charset=utf-8'
			: type.startsWith('text/') || type === 'application/json'
				? `${type}; charset=utf-8`
				: type;

	const headers: Record<string, string> = {
		'Content-Type': contentType,
		'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(attachment.filename)}"`,
		'Content-Length': String(bytes.length),
		'Cache-Control': 'private, max-age=3600',
		'X-Content-Type-Options': 'nosniff'
	};
	// Chrome's PDF viewer will not open in a sandboxed document, so PDFs rely
	// on their exact type and nosniff. Everything else is sandboxed with no script.
	if (type !== 'application/pdf' || !inline) {
		headers['Content-Security-Policy'] = "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'";
	}

	return new Response(body, { headers });
};
