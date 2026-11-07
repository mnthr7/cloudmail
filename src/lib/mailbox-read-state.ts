import type { ThreadSummary } from '#lib/types.ts';

/** Conversation key used by list + mark-read queries: thread_id, else the message id. */
export function conversationKey(email: { id: string; thread_id?: string | null }): string {
	return email.thread_id ?? email.id;
}

/** True when `id` is this row's newest message or its conversation key. */
export function threadMatchesMailboxId(
	thread: Pick<ThreadSummary, 'thread_id' | 'latest_id'>,
	id: string
): boolean {
	return thread.latest_id === id || thread.thread_id === id;
}

/** Flip read state on the matching mailbox row(s) without waiting for a refetch. */
export function applyThreadReadState<
	T extends Pick<ThreadSummary, 'thread_id' | 'latest_id' | 'is_read'>
>(threads: T[], ids: string | readonly string[], isRead: boolean): T[] {
	const matchIds = new Set(typeof ids === 'string' ? [ids] : ids);
	if (matchIds.size === 0) return threads;

	return threads.map((thread) => {
		for (const id of matchIds) {
			if (threadMatchesMailboxId(thread, id)) {
				return thread.is_read === isRead ? thread : { ...thread, is_read: isRead };
			}
		}
		return thread;
	});
}
