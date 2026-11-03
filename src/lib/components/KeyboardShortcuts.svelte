<script lang="ts">
	/**
	 * Ledger keyboard shortcuts. They drive the same buttons a mouse would
	 * (elements tagged data-kb="…"), so every shortcut goes through the real
	 * code path: star, trash, reply, open, close.
	 *
	 *   j / k     next / previous conversation in the list
	 *   o, Enter  open the conversation under the cursor
	 *   r         reply to the open conversation
	 *   s         star the open conversation (or the row under the cursor)
	 *   !         mark the open conversation as spam (or the row under the cursor)
	 *   #         trash the open conversation (or the row under the cursor)
	 *   x         expand every message in the open conversation
	 *   c         compose
	 *   /         search
	 *   Esc       close the open conversation
	 *
	 * Nothing fires while typing in a field, or with Ctrl/Cmd/Alt held.
	 */
	let { onCompose }: { onCompose: () => void } = $props();

	const CURSOR = 'data-kb-cursor';

	function typing(target: EventTarget | null): boolean {
		const el = target as HTMLElement | null;
		if (!el || !el.closest) return false;
		if (el.isContentEditable) return true;
		return Boolean(el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
	}

	function visible(el: Element | null): el is HTMLElement {
		return Boolean(el && (el as HTMLElement).getClientRects().length > 0);
	}

	/** First visible element for a data-kb name, optionally inside a scope. */
	function find(name: string, scope: ParentNode = document): HTMLElement | null {
		for (const el of scope.querySelectorAll<HTMLElement>(`[data-kb="${name}"]`)) {
			if (visible(el)) return el;
		}
		return null;
	}

	function rows(): HTMLElement[] {
		return [...document.querySelectorAll<HTMLElement>('.mailbox .row[data-thread-id]')].filter(
			visible
		);
	}

	function cursorRow(list = rows()): HTMLElement | null {
		return (
			list.find((row) => row.hasAttribute(CURSOR)) ??
			list.find((row) => row.classList.contains('selected')) ??
			null
		);
	}

	function move(step: number) {
		const list = rows();
		if (list.length === 0) return;
		const current = cursorRow(list);
		const index = current ? list.indexOf(current) : -1;
		const next = list[Math.max(0, Math.min(list.length - 1, index + step))] ?? list[0];
		for (const row of list) row.removeAttribute(CURSOR);
		next.setAttribute(CURSOR, '');
		next.scrollIntoView({ block: 'nearest' });
	}

	/** Thread-level action when a conversation is open, else the cursor row's. */
	function act(threadName: string, rowName: string) {
		const threadButton = find(threadName);
		if (threadButton) return threadButton.click();
		const row = cursorRow();
		if (row) row.querySelector<HTMLElement>(`[data-kb="${rowName}"]`)?.click();
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
		if (typing(event.target)) return;

		switch (event.key) {
			case 'j':
				move(1);
				break;
			case 'k':
				move(-1);
				break;
			case 'o':
			case 'Enter': {
				const row = cursorRow();
				const open = row?.querySelector<HTMLElement>('[data-kb="open"]');
				if (!open) return;
				open.click();
				break;
			}
			case 'r': {
				const reply = find('reply');
				if (!reply) return;
				reply.click();
				break;
			}
			case 's':
				act('star-thread', 'star');
				break;
			case '!':
				act('spam-thread', 'spam');
				break;
			case '#':
				act('trash-thread', 'trash');
				break;
			case 'x': {
				const expand = find('expand');
				if (!expand) return;
				expand.click();
				break;
			}
			case 'c':
				onCompose();
				break;
			case '/': {
				const search = find('search');
				if (!search) return;
				search.focus();
				break;
			}
			case 'Escape': {
				const close = find('close');
				if (!close) return;
				close.click();
				break;
			}
			default:
				return;
		}
		event.preventDefault();
	}
</script>

<svelte:window onkeydown={onKeydown} />
