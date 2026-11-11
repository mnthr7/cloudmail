import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { isCalendarAttachment, recordCalendarMail } from './calendar-invites.ts';
import { MAX_ICS_BYTES } from '#lib/calendar/ics-parse.ts';
import PostalMime, { type Address, type Attachment } from 'postal-mime';
import { insertAttachmentBytes } from './attachments';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_EMAIL } from './constants';
import { recordUnroutedEmail, resolveInboundRoute } from './domains';
import type { EmailProvider } from './email-provider';
import { cleanDisplayName, collectInboundRecipients, parseEmailAddress } from './email-address';
import { emailExistsByProviderId, insertEmail } from './mail-store';
import { organizeInbound, readInboundHeader } from './organize-inbound';
import { normalizeMessageId } from './send-mail';
import { cloudflareAuthResults } from '#lib/security/phishing.ts';

export type CloudflareInboundMessage = {
	readonly from: string;
	readonly to: string;
	readonly headers: Headers;
	readonly raw: ReadableStream<Uint8Array>;
	setReject(reason: string): void;
};

export type CloudflareInboundEnv = {
	DB: D1Database;
	ATTACHMENTS: R2Bucket;
	provider?: EmailProvider;
};

/**
 * Email Routing delivers the full MIME on `message.raw`. Parse once, then reuse
 * the same mailbox routing and D1/R2 store as the Resend webhook path.
 */
export async function handleCloudflareInbound(
	message: CloudflareInboundMessage,
	env: CloudflareInboundEnv
): Promise<void> {
	const raw = await new Response(message.raw).arrayBuffer();
	const parsed = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' });

	const envelopeTo = parseEmailAddress(message.to);
	const recipients = collectInboundRecipients({
		received_for: envelopeTo.includes('@') ? [envelopeTo] : [],
		to: mailboxAddresses(parsed.to),
		cc: mailboxAddresses(parsed.cc),
		bcc: mailboxAddresses(parsed.bcc)
	});

	const from = parseEmailAddress(message.from || mailboxAddresses(parsed.from)[0] || '');
	const fromName = postalDisplayName(parsed.from);
	const subject = parsed.subject?.trim() || message.headers.get('subject')?.trim() || '(no subject)';
	const messageId =
		normalizeMessageId(parsed.messageId ?? message.headers.get('message-id')) ?? null;
	const inReplyTo =
		normalizeMessageId(parsed.inReplyTo ?? message.headers.get('in-reply-to')) ?? null;
	const references = parsed.references ?? message.headers.get('references') ?? null;
	const providerId = await inboundProviderId({
		messageId,
		from,
		to: envelopeTo || recipients.join(','),
		date: parsed.date ?? message.headers.get('date')
	});

	if (await emailExistsByProviderId(env.DB, providerId)) {
		return;
	}

	const route = await resolveInboundRoute(env.DB, recipients);

	if (!route) {
		await recordUnroutedEmail(env.DB, {
			providerId,
			from,
			to: recipients.join(', ') || envelopeTo || '(unknown)',
			subject,
			reason: 'No matching address and no catch-all for this domain'
		});
		return;
	}

	const listUnsubscribe = readInboundHeader(message.headers, 'list-unsubscribe');
	const listUnsubscribePost = readInboundHeader(message.headers, 'list-unsubscribe-post');

	const emailId = await insertEmail(env.DB, {
		userId: route.userId,
		direction: 'inbound',
		from,
		fromName,
		to: route.address,
		cc: mailboxAddresses(parsed.cc).join(', ') || null,
		subject,
		bodyText: parsed.text ?? null,
		bodyHtml: parsed.html ?? null,
		messageId,
		inReplyTo,
		replyToHeader: readInboundHeader(message.headers, 'reply-to'),
		references,
		domainId: route.domainId,
		providerId,
		listUnsubscribe,
		listUnsubscribePost
	});

	const attachments = parsed.attachments ?? [];
	await storeInboundAttachments(env, emailId, attachments);
	const calendarFiles = attachments
		.filter((attachment) => isCalendarAttachment(attachment.mimeType, attachment.filename))
		.map((attachment) => attachmentBytes(attachment.content))
		.filter((bytes): bytes is Uint8Array => !!bytes && bytes.byteLength <= MAX_ICS_BYTES)
		.map((bytes) => new TextDecoder().decode(bytes));

	// A filter bug must not make Cloudflare retry delivery and store a second copy.
	try {
		await organizeInbound(
			env.DB,
			route.userId,
			emailId,
			{
				listId: readInboundHeader(message.headers, 'list-id'),
				inReplyTo: readInboundHeader(message.headers, 'in-reply-to'),
				references: readInboundHeader(message.headers, 'references'),
				listUnsubscribe,
				precedence: readInboundHeader(message.headers, 'precedence'),
				autoSubmitted: readInboundHeader(message.headers, 'auto-submitted'),
				appNotice: readInboundHeader(message.headers, 'x-cloudmail-notice'),
				// Cloudflare's own results, from the ARC set it added. An Authentication-Results
				// header here could only have come from the sender, so it isn't read.
				authenticationResults: cloudflareAuthResults(raw),
				receivedSpf: readInboundHeader(message.headers, 'received-spf'),
				hasAttachment: attachments.length > 0
			},
			env.provider
		);
	} catch (error) {
		console.error('Failed to organize inbound mail', emailId, error);
	}

	// Invites, updates, cancellations and RSVPs. Never blocks the mail itself.
	if (calendarFiles.length) {
		await recordCalendarMail(env.DB, route.userId, emailId, calendarFiles).catch((error) =>
			console.error('Failed to read the calendar part', emailId, error)
		);
	}
}

async function storeInboundAttachments(
	env: CloudflareInboundEnv,
	emailId: string,
	attachments: Attachment[]
): Promise<void> {
	for (const attachment of attachments.slice(0, MAX_ATTACHMENTS_PER_EMAIL)) {
		const bytes = attachmentBytes(attachment.content);
		if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES) {
			continue;
		}

		try {
			await insertAttachmentBytes(
				env.DB,
				env.ATTACHMENTS,
				emailId,
				{
					filename: attachment.filename || 'attachment',
					type: attachment.mimeType || 'application/octet-stream',
					bytes
				},
				'pending'
			);
		} catch (error) {
			console.error('Failed to store inbound Cloudflare attachment', attachment.filename, error);
		}
	}
}

/** PostalMime's display name. The envelope sender is only a mailbox. */
function postalDisplayName(value: Address | undefined): string | null {
	if (!value) return null;
	if (value.group) {
		const member = value.group.find((item) => item.address);
		return cleanDisplayName(member?.name);
	}
	return cleanDisplayName(value.name);
}

function mailboxAddresses(value: Address | Address[] | undefined): string[] {
	if (!value) return [];
	const list = Array.isArray(value) ? value : [value];
	const addresses: string[] = [];

	for (const item of list) {
		if (item.address) addresses.push(item.address);
		if (item.group) {
			for (const member of item.group) {
				if (member.address) addresses.push(member.address);
			}
		}
	}

	return addresses;
}

function attachmentBytes(content: Attachment['content']): Uint8Array | null {
	if (content instanceof ArrayBuffer) return new Uint8Array(content);
	if (ArrayBuffer.isView(content)) {
		return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
	}
	if (typeof content === 'string' && content.length > 0) {
		return new TextEncoder().encode(content);
	}
	return null;
}

async function inboundProviderId(input: {
	messageId: string | null;
	from: string;
	to: string;
	date: string | null | undefined;
}): Promise<string> {
	if (input.messageId) return input.messageId;

	const material = `${input.from}\n${input.to}\n${input.date ?? ''}`;
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
	const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
	return `cf-${hex.slice(0, 32)}`;
}
