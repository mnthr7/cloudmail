export const CATEGORIES = ['primary', 'social', 'promotions', 'updates', 'forums'] as const;
export type MailCategory = (typeof CATEGORIES)[number];

export type CategoryHeaders = {
	listId?: string | null;
	inReplyTo?: string | null;
	references?: string | null;
	listUnsubscribe?: string | null;
	precedence?: string | null;
	autoSubmitted?: string | null;
	from?: string | null;
};

const SOCIAL_DOMAINS = [
	'facebook.com',
	'facebookmail.com',
	'instagram.com',
	'linkedin.com',
	'x.com',
	'twitter.com'
];

const UPDATE_PREFIXES = ['noreply', 'no-reply', 'notifications', 'billing'];

export function isMailCategory(value: string | null | undefined): value is MailCategory {
	return CATEGORIES.includes(value as MailCategory);
}

export function assignCategory(
	headers: CategoryHeaders,
	senderOverride: MailCategory | null
): MailCategory {
	if (senderOverride) return senderOverride;
	const listId = headers.listId?.trim();
	if (listId && (headers.inReplyTo?.trim() || headers.references?.trim())) return 'forums';
	const precedence = headers.precedence?.trim().toLowerCase();
	if (headers.listUnsubscribe?.trim() || precedence === 'bulk' || precedence === 'list') {
		return 'promotions';
	}
	const auto = headers.autoSubmitted?.trim().toLowerCase();
	if ((auto && auto !== 'no') || localPartIsUpdate(headers.from)) return 'updates';
	if (domainIsSocial(headers.from)) return 'social';
	return 'primary';
}

function localPartIsUpdate(from: string | null | undefined): boolean {
	const address = bareAddress(from);
	const local = address.split('@')[0]?.toLowerCase() ?? '';
	return UPDATE_PREFIXES.some((prefix) => local.startsWith(prefix));
}

function domainIsSocial(from: string | null | undefined): boolean {
	const host = bareAddress(from).split('@')[1]?.toLowerCase() ?? '';
	return SOCIAL_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function bareAddress(value: string | null | undefined): string {
	const match = value?.match(/<([^>]+)>/);
	return (match?.[1] ?? value ?? '').trim().toLowerCase();
}
