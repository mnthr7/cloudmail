/**
 * Which selected conversations an inbox undo should restore.
 * Archive only moved conversations that were in the inbox.
 * Move to inbox only moved conversations that were not.
 * Omit `inboxIds` when every selected conversation shares `inInbox`.
 */
export function inboxUndoTargets(
	selectedIds: readonly string[],
	action: 'archive' | 'inbox',
	state: {
		inboxIds?: readonly string[];
		inInbox?: boolean;
		inboxMixed?: boolean;
	}
): string[] {
	const wereInInbox = inboxMembership(selectedIds, state);
	if (action === 'archive') return selectedIds.filter((id) => wereInInbox.has(id));
	return selectedIds.filter((id) => !wereInInbox.has(id));
}

function inboxMembership(
	selectedIds: readonly string[],
	state: {
		inboxIds?: readonly string[];
		inInbox?: boolean;
		inboxMixed?: boolean;
	}
): Set<string> {
	if (state.inboxIds) {
		const selected = new Set(selectedIds);
		return new Set(state.inboxIds.filter((id) => selected.has(id)));
	}
	if (state.inInbox && !state.inboxMixed) return new Set(selectedIds);
	return new Set();
}
