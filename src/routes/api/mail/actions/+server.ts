import { json, type RequestHandler } from '@sveltejs/kit';
import {
	deleteEmailsPermanently,
	emptyTrash,
	expandToThreads,
	markAllRead,
	setEmailFlags,
	getMailboxCounts
} from '#lib/server/mail-store.ts';
import {
	CONVERSATION_ACTIONS,
	OrganizingActionError,
	applyConversationAction,
	isConversationAction
} from '#lib/server/organizing-store.ts';
import { demoThreadInView } from '#lib/mailbox-view.ts';
import { DEMO_MODE, DEMO_USER, demoStore } from '#lib/server/demo.ts';

/** Bulk actions from the list toolbar. */
const ACTIONS = [
	'read',
	'unread',
	'star',
	'unstar',
	'trash',
	'restore',
	'spam',
	'unspam',
	'delete',
	'read-all',
	'empty-trash',
	...CONVERSATION_ACTIONS
] as const;

/** Actions that operate on the whole mailbox rather than a selection. */
const WHOLE_MAILBOX: Action[] = ['read-all', 'empty-trash'];

type Action = (typeof ACTIONS)[number];

type ActionBody = {
	action?: Action;
	ids?: string[];
	until?: string;
	category?: string;
	labelId?: string;
	address?: string;
};

export const POST: RequestHandler = async ({ request, locals, platform, url }) => {
	const db = platform?.env.DB;
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const body = (await request.json()) as ActionBody;
	const action = body.action;

	if (!action || !ACTIONS.includes(action)) {
		return json({ error: 'Unknown action' }, { status: 400 });
	}

	const selected = (body.ids ?? []).filter((id) => typeof id === 'string' && id.length > 0);
	if (selected.length === 0 && !WHOLE_MAILBOX.includes(action)) {
		return json({ error: 'No messages selected' }, { status: 400 });
	}

	// Demo mode: update fake data
	// Demo mode is server-env only (DEMO_MODE="true"), never a URL param.
	const isDemoMode = DEMO_MODE;

	if (isDemoMode && locals.user.id === DEMO_USER.id) {
		if (isConversationAction(action)) {
			return json({ error: 'Demo mode is read-only' }, { status: 403 });
		}

		let affected = 0;

		selected.forEach((id) => {
			switch (action) {
				case 'read':
					demoStore.updateThread(id, { is_read: true });
					affected++;
					break;
				case 'unread':
					demoStore.updateThread(id, { is_read: false });
					affected++;
					break;
				case 'star':
					demoStore.updateThread(id, { is_starred: true });
					affected++;
					break;
				case 'unstar':
					demoStore.updateThread(id, { is_starred: false });
					affected++;
					break;
				case 'trash':
					demoStore.updateThread(id, { trashed: true });
					affected++;
					break;
				case 'restore':
					demoStore.updateThread(id, { trashed: false });
					affected++;
					break;
				case 'spam':
					demoStore.updateThread(id, { spam: true, trashed: false });
					affected++;
					break;
				case 'unspam':
					demoStore.updateThread(id, { spam: false });
					affected++;
					break;
			}
		});

		const threads = demoStore.getThreads();
		const counts = {
			inbox_unread: threads.filter((thread) => demoThreadInView(thread, 'inbox') && !thread.is_read)
				.length,
			starred: threads.filter((thread) => demoThreadInView(thread, 'starred')).length,
			drafts: threads.filter((thread) => demoThreadInView(thread, 'drafts')).length,
			spam: threads.filter((thread) => demoThreadInView(thread, 'spam')).length,
			trash: threads.filter((thread) => demoThreadInView(thread, 'trash')).length
		};

		return json({ ok: true, affected, counts });
	}

	if (!db) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	// The list works in conversations, so an action on a row applies to every
	// message in it — trashing a thread takes its replies along.
	const ids = await expandToThreads(db, locals.user.id, selected);

	let affected = 0;

	if (isConversationAction(action)) {
		try {
			affected = await applyConversationAction(db, locals.user.id, ids, action, {
				until: body.until,
				category: body.category,
				labelId: body.labelId,
				address: body.address
			});
		} catch (error) {
			if (error instanceof OrganizingActionError) {
				return json({ error: error.message }, { status: 400 });
			}
			throw error;
		}
	} else {
		switch (action) {
			case 'read':
				affected = await setEmailFlags(db, locals.user.id, ids, { isRead: true });
				break;
			case 'unread':
				affected = await setEmailFlags(db, locals.user.id, ids, { isRead: false });
				break;
			case 'star':
				affected = await setEmailFlags(db, locals.user.id, ids, { isStarred: true });
				break;
			case 'unstar':
				affected = await setEmailFlags(db, locals.user.id, ids, { isStarred: false });
				break;
			case 'trash':
				affected = await setEmailFlags(db, locals.user.id, ids, { trashed: true });
				break;
			case 'restore':
				affected = await setEmailFlags(db, locals.user.id, ids, { trashed: false });
				break;
			case 'spam':
				affected = await setEmailFlags(db, locals.user.id, ids, { spam: true });
				break;
			case 'unspam':
				affected = await setEmailFlags(db, locals.user.id, ids, { spam: false });
				break;
			case 'delete':
				affected = await deleteEmailsPermanently(
					db,
					platform?.env.ATTACHMENTS,
					locals.user.id,
					ids
				);
				break;
			case 'read-all':
				affected = await markAllRead(db, locals.user.id, locals.activeDomainId);
				break;
			case 'empty-trash':
				affected = await emptyTrash(db, platform?.env.ATTACHMENTS, locals.user.id);
				break;
		}
	}

	const counts = await getMailboxCounts(db, locals.user.id, locals.activeDomainId);

	return json({ ok: true, affected, counts });
};
