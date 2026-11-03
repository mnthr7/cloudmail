import { conversationInView } from './organizing/membership';
import type { MailboxView } from './types';

type DemoThreadFlags = {
	trashed?: boolean;
	spam?: boolean;
	is_draft?: boolean;
	is_starred?: boolean;
	direction?: string;
	in_inbox?: boolean;
	snoozed_until?: string | null;
	category?: 'primary' | 'social' | 'promotions' | 'updates' | 'forums';
	label_ids?: string[];
	is_scheduled?: boolean;
};

export function demoThreadInView(thread: DemoThreadFlags, view: MailboxView): boolean {
	return conversationInView(
		{
			trashed: thread.trashed,
			spam: thread.spam,
			isDraft: thread.is_draft,
			isStarred: thread.is_starred,
			direction: thread.direction,
			inInbox: thread.in_inbox,
			snoozedUntil: thread.snoozed_until,
			category: thread.category ?? 'primary',
			labelIds: thread.label_ids,
			isScheduled: thread.is_scheduled
		},
		view
	);
}
