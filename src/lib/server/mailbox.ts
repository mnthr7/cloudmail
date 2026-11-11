import { listMailbox } from './mail-store';
import { readPriorityInbox } from '#lib/server/auth.ts';
import { demoThreadInView } from '#lib/mailbox-view.ts';
import { isMailCategory } from '#lib/organizing/categories.ts';
import type { MailboxFilters, MailboxPage, MailboxView } from '#lib/types.ts';
import type { D1Database } from '@cloudflare/workers-types';
import { DEMO_MODE, DEMO_USER, demoStore } from './demo';
import { tabNewsForInbox, type TabNews } from './whats-new.ts';

export function readFilters(url: URL): MailboxFilters {
	return {
		q: url.searchParams.get('q')?.trim() ?? '',
		unreadOnly: url.searchParams.get('unread') === '1',
		starredOnly: url.searchParams.get('starred') === '1',
		attachmentsOnly: url.searchParams.get('attachments') === '1'
	};
}

const EMPTY: MailboxPage = { threads: [], total: 0, page: 1, pageCount: 1, pageSize: 25 };

/** Shared by every mailbox route — same query shape, different view. */
export async function loadMailbox(
	db: D1Database | undefined,
	userId: string | undefined,
	view: MailboxView,
	url: URL,
	domainId: string | null,
	options?: { labelId?: string }
): Promise<{
	view: MailboxView;
	mailbox: MailboxPage;
	filters: MailboxFilters;
	priorityInbox: boolean;
	/** "N new" per inbox tab since you last opened it. */
	tabNews: TabNews;
}> {
	const filters = readFilters(url);
	const requestedCategory = url.searchParams.get('category');
	const category = isMailCategory(requestedCategory)
		? requestedCategory
		: view === 'inbox'
			? 'primary'
			: null;

	// Demo mode: return fake data
	// Demo mode is server-env only (DEMO_MODE="true"), never a URL param.
	const isDemoMode = DEMO_MODE;

	if (isDemoMode && userId === DEMO_USER.id) {
		const allThreads = demoStore.getThreads();
		let threads = allThreads.filter((thread) => demoThreadInView(thread, view));
		if (view === 'inbox' && category) {
			threads = threads.filter((thread) => (thread.category ?? 'primary') === category);
		}
		if (options?.labelId) {
			const labelId = options.labelId;
			threads = threads.filter((thread) => thread.labels.some((label) => label.id === labelId));
		}

		// Apply filters
		if (filters.q) {
			const q = filters.q.toLowerCase();
			threads = threads.filter(
				(t) =>
					t.subject.toLowerCase().includes(q) ||
					t.preview.toLowerCase().includes(q) ||
					t.from_addr.toLowerCase().includes(q)
			);
		}
		if (filters.unreadOnly) threads = threads.filter((t) => !t.is_read);
		if (filters.starredOnly) threads = threads.filter((t) => t.is_starred);
		if (filters.attachmentsOnly) threads = threads.filter((t) => t.has_attachments);

		return {
			view,
			mailbox: { threads, total: threads.length, page: 1, pageCount: 1, pageSize: 25 },
			filters,
			priorityInbox: false,
			tabNews: {}
		};
	}

	if (!db || !userId) {
		return { view, mailbox: EMPTY, filters, priorityInbox: false, tabNews: {} };
	}

	const priorityInbox = view === 'inbox' ? await readPriorityInbox(db, userId) : false;

	const mailbox = await listMailbox(db, userId, {
		view,
		domainId,
		q: filters.q,
		unreadOnly: filters.unreadOnly,
		starredOnly: filters.starredOnly,
		attachmentsOnly: filters.attachmentsOnly,
		labelId: options?.labelId,
		category,
		priorityInbox,
		page: Number(url.searchParams.get('page')) || 1
	});

	const tabNews =
		view === 'inbox' ? await tabNewsForInbox(db, userId, domainId, category) : {};

	return { view, mailbox, filters, priorityInbox, tabNews };
}
