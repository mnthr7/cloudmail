import type { MailCategory } from './categories';
import type { MailboxView } from '../types';

export type OrganizingFlags = {
	trashed?: boolean;
	spam?: boolean;
	isDraft?: boolean;
	isScheduled?: boolean;
	isStarred?: boolean;
	direction?: 'inbound' | 'outbound' | string;
	inInbox?: boolean;
	snoozedUntil?: string | null;
	category?: MailCategory;
	labelIds?: string[];
};

export function conversationInView(
	thread: OrganizingFlags,
	view: MailboxView,
	now = new Date(),
	labelId?: string,
	category?: MailCategory
): boolean {
	if (view === 'trash') return Boolean(thread.trashed);
	if (thread.trashed) return false;
	if (view === 'spam') return Boolean(thread.spam);
	if (thread.spam) return false;
	const live = true;
	if (view === 'snoozed') return live && snoozeIsFuture(thread.snoozedUntil, now);
	if (view === 'all') return live && hasLabel(thread, labelId);
	if (view === 'inbox') {
		return (
			thread.direction !== 'outbound' &&
			!thread.isDraft &&
			thread.inInbox !== false &&
			!snoozeIsFuture(thread.snoozedUntil, now) &&
			(!category || thread.category === category) &&
			hasLabel(thread, labelId)
		);
	}
	if (view === 'starred') return Boolean(thread.isStarred) && !thread.isDraft;
	if (view === 'sent') return thread.direction === 'outbound' && !thread.isDraft && !thread.isScheduled;
	if (view === 'drafts') return Boolean(thread.isDraft);
	if (view === 'scheduled') return !thread.trashed && !thread.spam && Boolean(thread.isScheduled);
	return false;
}

function hasLabel(thread: OrganizingFlags, labelId?: string): boolean {
	if (!labelId) return true;
	return Boolean(thread.labelIds?.includes(labelId));
}

function snoozeIsFuture(iso: string | null | undefined, now: Date): boolean {
	if (!iso) return false;
	const time = Date.parse(iso);
	return Number.isFinite(time) && time > now.getTime();
}
