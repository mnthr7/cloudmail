import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { isValidLocalPart, localPartOf, parseEmailAddress } from '#lib/email-address.ts';
import type { Domain, MailAddress, OutboundAttachmentInput, User } from '#lib/types.ts';
import { base64ByteLength, insertAttachments } from './attachments';
import { MAX_TOTAL_ATTACHMENT_BYTES } from './constants';
import {
	getAddressByValueForUser,
	getAddressForUser,
	getDefaultAddress,
	getDomainByName
} from './domains';
import { stripHtml } from './html';
import { insertEmail } from './mail-store';
import { organizeInbound } from './organize-inbound';
import { initialOutboundStatus, type EmailProvider } from './email-provider';
import { parseRecipients, sendOutboundEmail } from './send-mail';

export type ComposeInput = {
	fromAddressId?: string | null;
	/** Explicit From address, used for catch-all locals that have no addresses row. */
	fromAddress?: string | null;
	/**
	 * Addresses the message being replied to was received at. Sending from one of
	 * these is allowed without an addresses row: the mail is already in this
	 * user's mailbox, so they own that address for this conversation.
	 */
	receivedAt?: string[];
	to: string;
	cc?: string | null;
	bcc?: string | null;
	subject: string;
	text?: string | null;
	html?: string | null;
	inReplyTo?: string | null;
	references?: string | null;
	replyToEmailId?: string | null;
	attachments?: OutboundAttachmentInput[];
};

function synthesizeCatchallAddress(user: User, domain: Domain, address: string): MailAddress {
	return {
		id: `catchall:${address}`,
		user_id: user.id,
		domain_id: domain.id,
		domain_name: domain.name,
		address,
		label: null,
		is_default: false,
		created_at: new Date().toISOString()
	};
}

/**
 * Send from a catch-all local on a connected, sending-enabled domain this user
 * owns. Never invents a From on someone else's domain.
 */
async function resolveCatchallFromAddress(
	db: D1Database,
	user: User,
	fromAddress: string,
	receivedAt: string[] = []
): Promise<MailAddress | null> {
	const address = parseEmailAddress(fromAddress);
	const localPart = localPartOf(address);
	const domainName = address.split('@')[1];
	if (!localPart || !domainName || !isValidLocalPart(localPart)) {
		return null;
	}

	const domain = await getDomainByName(db, domainName);
	if (!domain) return null;

	// Must be a domain this user owns the catch-all of. The address the
	// conversation was received at is allowed even if the cached sending flag is
	// stale; any other local needs a sending-enabled domain.
	if (domain.catchall_user_id !== user.id) return null;
	const receivedHere = receivedAt.some((value) => parseEmailAddress(value) === address);
	if (!receivedHere && !domain.sending_enabled) return null;

	return synthesizeCatchallAddress(user, domain, address);
}

/**
 * Pick the identity a message is sent from: the one the composer chose, or the
 * user's default. Only addresses the user actually owns are accepted — including
 * catch-all locals on a domain they own, which may not have an addresses row.
 */
export async function resolveFromAddress(
	db: D1Database,
	user: User,
	addressId?: string | null,
	fromAddress?: string | null,
	receivedAt: string[] = []
): Promise<MailAddress> {
	if (addressId) {
		const owned = await getAddressForUser(db, user.id, addressId);
		if (owned) return owned;
	}

	if (fromAddress?.trim()) {
		const parsed = parseEmailAddress(fromAddress);
		const owned = await getAddressByValueForUser(db, user.id, parsed);
		if (owned) return owned;

		const catchall = await resolveCatchallFromAddress(db, user, parsed, receivedAt);
		if (catchall) return catchall;

		throw new Error('You cannot send from that address.');
	}

	if (addressId) {
		throw new Error('You cannot send from that address.');
	}

	const address = await getDefaultAddress(db, user.id);
	if (!address) {
		throw new Error('No sending address configured. Add one in Settings first.');
	}

	return address;
}

/** Send through the configured provider, then record it in the Sent folder. */
export async function sendAndStore(
	env: { DB: D1Database; ATTACHMENTS: R2Bucket },
	provider: EmailProvider,
	user: User,
	input: ComposeInput
): Promise<{ emailId: string; providerId: string; from: MailAddress }> {
	// resolveFromAddress scopes the lookup to this user, so ownership is implied.
	const from = await resolveFromAddress(
		env.DB,
		user,
		input.fromAddressId,
		input.fromAddress,
		input.receivedAt
	);

	const html = input.html?.trim() || null;
	const text = input.text?.trim() || (html ? stripHtml(html) : '');

	if (!text && !html) {
		throw new Error('Message body is required');
	}

	const attachments = input.attachments ?? [];
	const totalBytes = attachments.reduce(
		(sum, file) => sum + base64ByteLength(file.content),
		0
	);
	if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
		throw new Error('Attachments exceed the total size limit');
	}

	const { providerId } = await sendOutboundEmail(provider, {
		from,
		senderName: user.name,
		to: input.to,
		cc: input.cc ?? undefined,
		bcc: input.bcc ?? undefined,
		subject: input.subject,
		text,
		html: html ?? undefined,
		inReplyTo: input.inReplyTo,
		references: input.references,
		attachments
	});

	const emailId = await insertEmail(env.DB, {
		userId: user.id,
		direction: 'outbound',
		from: from.address,
		to: parseRecipients(input.to).join(', '),
		cc: parseRecipients(input.cc).join(', ') || null,
		bcc: parseRecipients(input.bcc).join(', ') || null,
		subject: input.subject.trim(),
		bodyText: text,
		bodyHtml: html ?? text.replaceAll('\n', '<br>\n'),
		inReplyTo: input.inReplyTo ?? null,
		references: input.references ?? null,
		replyToEmailId: input.replyToEmailId ?? null,
		domainId: from.domain_id,
		providerId,
		status: initialOutboundStatus(provider.kind),
		isRead: true
	});

	if (attachments.length > 0) {
		await insertAttachments(env.DB, env.ATTACHMENTS, emailId, attachments);
	}

	// The provider already accepted the message. Filing only copies the
	// conversation's flags onto this row, and a failure must not fail the send.
	try {
		await organizeInbound(env.DB, user.id, emailId, {
			hasAttachment: attachments.length > 0
		});
	} catch (error) {
		console.error('Failed to organize outbound mail', emailId, error);
	}

	return { emailId, providerId, from };
}
