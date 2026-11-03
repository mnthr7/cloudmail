import type { LayoutServerLoad } from './$types';
import { getMailboxCounts } from '$lib/server/mail-store';
import { listImageSenders } from '$lib/server/image-senders';
import { listLabels, type LabelRecord } from '$lib/server/labels-store';
import { demoThreadInView } from '$lib/mailbox-view';
import { DEMO_LABELS, DEMO_MODE, DEMO_USER, demoStore } from '$lib/server/demo';
import type { MailboxCounts } from '$lib/types';

const EMPTY_COUNTS: MailboxCounts = {
	inbox: 0,
	inbox_unread: 0,
	starred: 0,
	drafts: 0,
	sent: 0,
	scheduled: 0,
	spam: 0,
	trash: 0,
	all: 0,
	snoozed: 0
};

export const load: LayoutServerLoad = async ({ locals, platform, url }) => {
	const db = platform?.env.DB;

	// Check if we're in demo mode
	// Demo mode is server-env only (DEMO_MODE="true"), never a URL param.
	const isDemoMode = DEMO_MODE;

		// Generate demo counts if in demo mode
	let counts = EMPTY_COUNTS;
	if (isDemoMode && locals.user?.id === DEMO_USER.id) {
		const threads = demoStore.getThreads();
		counts = {
			inbox: threads.filter((thread) => demoThreadInView(thread, 'inbox')).length,
			inbox_unread: threads.filter((thread) => demoThreadInView(thread, 'inbox') && !thread.is_read)
				.length,
			starred: threads.filter((thread) => demoThreadInView(thread, 'starred')).length,
			drafts: threads.filter((thread) => demoThreadInView(thread, 'drafts')).length,
			sent: threads.filter((thread) => demoThreadInView(thread, 'sent')).length,
			scheduled: threads.filter((thread) => demoThreadInView(thread, 'scheduled')).length,
			spam: threads.filter((thread) => demoThreadInView(thread, 'spam')).length,
			trash: threads.filter((thread) => demoThreadInView(thread, 'trash')).length,
			all: threads.filter((thread) => demoThreadInView(thread, 'all')).length,
			snoozed: threads.filter((thread) => demoThreadInView(thread, 'snoozed')).length
		};
	} else if (db && locals.user) {
		counts = await getMailboxCounts(db, locals.user.id, locals.activeDomainId);
	}

	// Demo mode shows fixed sample labels. A New label write stays the existing 403.
	let labels: LabelRecord[] = [];
	if (isDemoMode && locals.user?.id === DEMO_USER.id) {
		labels = DEMO_LABELS;
	} else if (db && locals.user) {
		labels = await listLabels(db, locals.user.id);
	}

	let trustedAddresses: string[] = [];
	if (db && locals.user) {
		trustedAddresses = await listImageSenders(db, locals.user.id);
	}

	return {
		user: locals.user,
		domains: locals.domains,
		addresses: locals.addresses,
		activeDomainId: locals.activeDomainId,
		skin: locals.skin,
		counts,
		labels,
		trustedAddresses
	};
};
