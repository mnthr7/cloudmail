<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page as currentPage } from '$app/state';
	import Icon from './Icon.svelte';
	import EmptyState from './EmptyState.svelte';
	import DeliveryStatus from './DeliveryStatus.svelte';
	import OrganizeMenu from './OrganizeMenu.svelte';
	import { showToast } from '#lib/toast.ts';
	import { applyThreadReadState } from '#lib/mailbox-read-state.ts';
	import { CATEGORIES, isMailCategory, type MailCategory } from '#lib/organizing/categories.ts';
	import { dateGroup, formatRelativeDate } from '#lib/utils/date.ts';
	import { senderWarning } from '#lib/security/sender.ts';
	import type { MailboxFilters, MailboxPage, MailboxView, ThreadSummary } from '#lib/types.ts';

	const CATEGORY_LABELS: Record<MailCategory, string> = {
		primary: 'Primary',
		social: 'Social',
		promotions: 'Promotions',
		updates: 'Updates',
		forums: 'Forums'
	};

	let {
		view,
		mailbox,
		filters,
		hiddenIds = [],
		onThreadSelect,
		selectedThreadId

		/** Threads already removed by the reader, ahead of the server round trip. */
	}: { 
		view: MailboxView;
		mailbox: MailboxPage;
		filters: MailboxFilters;
		hiddenIds?: string[];
		onThreadSelect?: (id: string) => void;
		selectedThreadId?: string | null;
	} = $props();

	const META: Record<MailboxView, { title: string; icon: string; empty: string }> = {
		all: { title: 'All Mail', icon: 'archive-line', empty: 'Nothing in All Mail' },
		snoozed: { title: 'Snoozed', icon: 'time-line', empty: 'Nothing snoozed' },
		inbox: { title: 'Inbox', icon: 'inbox-line', empty: 'Your inbox is empty' },
		starred: { title: 'Starred', icon: 'star-line', empty: 'No starred messages' },
		drafts: { title: 'Drafts', icon: 'draft-line', empty: 'No drafts saved' },
		sent: { title: 'Sent', icon: 'send-plane-line', empty: 'Nothing sent yet' },
		scheduled: { title: 'Scheduled', icon: 'time-line', empty: 'Nothing scheduled' },
		spam: { title: 'Spam', icon: 'spam-2-line', empty: 'Spam is empty' },
		trash: { title: 'Trash', icon: 'delete-bin-line', empty: 'Trash is empty' }
	};

	const meta = $derived(META[view]);

	/** Inbox unread count for the paper skins' "1 unread · 248 conversations" line. */
	const unreadCount = $derived(view === 'inbox'
		? currentPage.data.counts?.inbox_unread as number | undefined ?? 0
		: 0);

	/** Date dividers (Today, Yesterday, …) with how many rows each holds. */
	const groups = $derived.by(() => {
		const sizes = new Map<string, number>();
		const firstOf = new Map<string, string>();
		for (const thread of items) {
			const group = dateGroup(thread.created_at);
			sizes.set(group, (sizes.get(group) ?? 0) + 1);
			if (!firstOf.has(group)) firstOf.set(group, thread.thread_id);
		}
		return { sizes, firstOf };
	});

	// Local copy so stars and reads can flip before the server round trip lands.
	let items = $state<ThreadSummary[]>([]);
	let selected = $state<string[]>([]);
	let busy = $state(false);
	let filterOpen = $state(false);
	let moreOpen = $state(false);
	let selectMenuOpen = $state(false);

	$effect(() => {
		items = mailbox.threads.filter((thread) => !hiddenIds.includes(thread.latest_id));
		selected = [];
	});

	const allSelected = $derived(items.length > 0 && selected.length === items.length);
	const someSelected = $derived(selected.length > 0);
	const selectedThreads = $derived(items.filter((thread) => selected.includes(thread.latest_id)));

	function selectionMode(pick: (thread: ThreadSummary) => boolean): boolean | 'mixed' {
		const values = new Set(selectedThreads.map(pick));
		if (values.size > 1) return 'mixed';
		return [...values][0] ?? false;
	}

	const inboxMode = $derived(selectionMode((thread) => thread.in_inbox));
	const selectedInboxIds = $derived(
		selectedThreads.filter((thread) => thread.in_inbox).map((thread) => thread.latest_id)
	);
	const mutedMode = $derived(selectionMode((thread) => thread.is_muted));
	const importantMode = $derived(selectionMode((thread) => thread.is_important));
	const activeCategory = $derived.by(() => {
		const value = currentPage.url.searchParams.get('category');
		return isMailCategory(value) ? value : 'primary';
	});
	const serverPriority = $derived(Boolean(currentPage.data.priorityInbox));
	let priorityOverride = $state<boolean | null>(null);
	let priorityBusy = $state(false);
	const priorityOn = $derived(priorityOverride ?? serverPriority);

	$effect(() => {
		if (priorityOverride !== null && priorityOverride === serverPriority) priorityOverride = null;
	});
	const activeFilterCount = $derived(
		[filters.unreadOnly, filters.starredOnly, filters.attachmentsOnly].filter(Boolean).length
	);

	/**
	 * Who to show on the row. Sent and Drafts are about where a message went, so
	 * they name the recipient; everywhere else names the people in the thread.
	 */
	function people(thread: ThreadSummary): string {
		if (view === 'drafts' || view === 'scheduled' || view === 'sent' && thread.participants.every((p) => p.self)) {
			return recipientOf(thread) || (view === 'drafts' || view === 'scheduled' ? 'No recipient' : 'Unknown');
		}

		return thread.participants.map((participant) => participant.label).join(', ');
	}

	function recipientOf(thread: ThreadSummary): string {
		const [first] = thread.participants;
		return first?.address ? first.address.split('@')[0].replace(/[._-]+/g, ' ') : '';
	}

	/** First disagreeing display name among the other people on the row. */
	function participantWarning(thread: ThreadSummary): string | null {
		for (const participant of thread.participants) {
			if (participant.self) continue;
			if (participant.label.toLowerCase() === participant.address.toLowerCase()) continue;
			const sentence = senderWarning(`${participant.label} <${participant.address}>`);
			if (sentence) return sentence;
		}
		return null;
	}

	function initial(thread: ThreadSummary): string {
		const external = thread.participants.find((participant) => !participant.self);
		return ((external ?? thread.participants[0])?.address[0] ?? '?').toUpperCase();
	}

	/** Rows carry the newest message; opening it opens the whole conversation. */
	function href(thread: ThreadSummary): string {
		return thread.is_draft ? `/compose?draft=${thread.latest_id}` : `/mail/${thread.latest_id}`;
	}

	function toggle(id: string) {
		selected = selected.includes(id)
			? selected.filter((value) => value !== id)
			: [...selected, id];
	}

	function selectAll(next: boolean) {
		selected = next ? items.map((thread) => thread.latest_id) : [];
	}

	function selectWhere(predicate: (thread: ThreadSummary) => boolean) {
		selected = items.filter(predicate).map((thread) => thread.latest_id);
		selectMenuOpen = false;
	}

	/** In-list API path (demo mode is server-env only; no ?demo param). */
	function mailApiPath(path: string): string {
		return path;
	}

	/** One entry point for every list action, so the UI always refreshes after. */
	async function run(action: string, ids: string[] = selected) {
		if (busy) return;
		busy = true;
		const before = items;
		try {
			if (action === 'read' || action === 'unread') {
				items = applyThreadReadState(items, ids, action === 'read');
			}
			if (action === 'trash' || action === 'delete' || action === 'spam' || action === 'unspam') {
				items = items.filter((thread) => !ids.includes(thread.latest_id));
			}
			const res = await fetch(mailApiPath('/api/mail/actions'), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action, ids })
			});
			if (!res.ok) throw new Error(String(res.status));
			selected = [];
			if (action === 'trash' || action === 'spam') {
				const spam = action === 'spam';
				showToast(
					spam
						? ids.length > 1
							? `Marked ${ids.length} conversations as spam`
							: 'Marked as spam'
						: ids.length > 1
							? `Moved ${ids.length} conversations to trash`
							: 'Moved to trash',
					{
						actionLabel: 'Undo',
						onAction: async () => {
							await fetch(mailApiPath('/api/mail/actions'), {
								method: 'POST',
								headers: { 'Content-Type': 'application/json' },
								body: JSON.stringify({ action: spam ? 'unspam' : 'restore', ids })
							}).catch(() => {});
							await invalidateAll();
						}
					}
				);
			}
			if (action === 'unspam') {
				showToast('Removed from spam');
			}
			await invalidateAll();
		} catch {
			items = before;
			showToast("That didn't go through. Check your connection and try again.", {
				kind: 'error'
			});
		} finally {
			busy = false;
			moreOpen = false;
		}
	}

	async function cancelScheduled(thread: ThreadSummary) {
		if (busy) return;
		busy = true;
		const before = items;
		items = items.filter((row) => row.thread_id !== thread.thread_id);
		try {
			const res = await fetch(`/api/mail/${encodeURIComponent(thread.latest_id)}/cancel`, { method: 'POST' });
			const body = await res.json().catch(() => null) as { status?: string } | null;

			if (body?.status === 'sent') {
				items = before;
				showToast('Already sent');
			} else if (body?.status !== 'draft') {
				items = before;
				showToast("That didn't go through. Check your connection and try again.", {
					kind: 'error'
				});
			}
			await invalidateAll();
		} catch {
			items = before;
			showToast("That didn't go through. Check your connection and try again.", { kind: 'error' });
		} finally {
			busy = false;
		}
	}

	function openThread(thread: ThreadSummary) {
		items = applyThreadReadState(items, thread.latest_id, true);
		onThreadSelect?.(thread.latest_id);
	}

	async function toggleStar(thread: ThreadSummary) {
		const isStarred = !thread.is_starred;
		items = items.map((row) =>
			row.thread_id === thread.thread_id ? { ...row, is_starred: isStarred } : row
		);

		try {
			const res = await fetch(mailApiPath(`/api/mail/${thread.latest_id}`), {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ isStarred })
			});
			if (!res.ok) throw new Error(String(res.status));
		} catch {
			items = items.map((row) =>
				row.thread_id === thread.thread_id ? { ...row, is_starred: !isStarred } : row
			);
			showToast("Couldn't update the star.", { kind: 'error' });
		}
		await invalidateAll();
	}

	/** Builds a URL for this mailbox with some query params changed. */
	function withParams(changes: Record<string, string | number | boolean | null>): string {
		const params = new URLSearchParams(currentPage.url.searchParams);

		for (const [key, value] of Object.entries(changes)) {
			if (value === null || value === false || value === '') params.delete(key);
			else params.set(key, String(value));
		}

		// Changing what is listed invalidates the current page number.
		if (!('page' in changes)) params.delete('page');

		const query = params.toString();
		return `${currentPage.url.pathname}${query ? `?${query}` : ''}`;
	}

	function apply(changes: Record<string, string | number | boolean | null>) {
		filterOpen = false;
		goto(withParams(changes));
	}

	function preferenceError(body: unknown): string {
		if (
			body &&
			typeof body === 'object' &&
			'error' in body &&
			typeof body.error === 'string' &&
			body.error
		) {
			return body.error;
		}
		return "Couldn't update Priority Inbox.";
	}

	async function setPriority(next: boolean) {
		if (priorityBusy || next === priorityOn) return;
		priorityBusy = true;
		try {
			const res = await fetch('/api/preferences', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ priorityInbox: next })
			});
			const body = await res.json().catch(() => null);
			if (!res.ok) {
				showToast(preferenceError(body), { kind: 'error' });
				return;
			}
			priorityOverride = next;
			await invalidateAll();
		} catch {
			showToast("Couldn't update Priority Inbox.", { kind: 'error' });
		} finally {
			priorityBusy = false;
		}
	}

	const rangeStart = $derived(
		mailbox.total === 0 ? 0 : (mailbox.page - 1) * mailbox.pageSize + 1
	);
	const rangeEnd = $derived(Math.min(mailbox.page * mailbox.pageSize, mailbox.total));
</script>

<section class="mailbox">
	<header class="toolbar">
		<div class="toolbar-left">
			<div class="select-all">
				<input
					type="checkbox"
					class="checkbox"
					aria-label="Select all messages"
					checked={allSelected}
					indeterminate={someSelected && !allSelected}
					onchange={(event) => selectAll(event.currentTarget.checked)}
				/>
				<button
					type="button"
					class="caret"
					aria-label="Selection options"
					aria-expanded={selectMenuOpen}
					onclick={() => selectMenuOpen = !selectMenuOpen}
				><Icon name="arrow-down-s-line" size={14} /></button>

				{#if selectMenuOpen}
					<button
						type="button"
						class="backdrop"
						aria-label="Close menu"
						onclick={() => selectMenuOpen = false}
					></button>
					<div class="menu menu-left" role="menu">
						<button type="button" class="menu-item" onclick={() => selectWhere(() => true)}>
							All
						</button>
						<button type="button" class="menu-item" onclick={() => selectWhere(() => false)}>
							None
						</button>
						<button type="button" class="menu-item" onclick={() => selectWhere((e) => !e.is_read)}>
							Unread
						</button>
						<button type="button" class="menu-item" onclick={() => selectWhere((e) => e.is_read)}>
							Read
						</button>
						<button type="button" class="menu-item" onclick={() => selectWhere((e) => e.is_starred)}>
							Starred
						</button>
					</div>
				{/if}
			</div>

			{#if someSelected}
				<span class="selected-count">{selected.length} selected</span>

				<div class="bulk-actions">
					<button
						type="button"
						class="tool-btn"
						title="Mark as read"
						disabled={busy}
						onclick={() => run('read')}
					>
						<Icon name="mail-open-line" size={16} />
					</button>
					<button
						type="button"
						class="tool-btn"
						title="Mark as unread"
						disabled={busy}
						onclick={() => run('unread')}
					>
						<Icon name="mail-line" size={16} />
					</button>
					<button
						type="button"
						class="tool-btn"
						title="Star"
						disabled={busy}
						onclick={() => run('star')}
					>
						<Icon name="star-line" size={16} />
					</button>
					<button
						type="button"
						class="tool-btn"
						title="Remove star"
						disabled={busy}
						onclick={() => run('unstar')}
					>
						<Icon name="star-off-line" size={16} />
					</button>

					{#if view === 'trash'}
						<button
							type="button"
							class="tool-btn"
							title="Restore"
							disabled={busy}
							onclick={() => run('restore')}
						>
							<Icon name="arrow-go-back-line" size={16} />
						</button>
						<button
							type="button"
							class="tool-btn danger"
							title="Delete permanently"
							disabled={busy}
							onclick={() => run('delete')}
						>
							<Icon name="delete-bin-2-line" size={16} />
						</button>
					{:else if view === 'spam'}
						<button
							type="button"
							class="tool-btn"
							title="Not spam"
							disabled={busy}
							onclick={() => run('unspam')}
						>
							<Icon name="mail-check-line" size={16} />
						</button>
						<button
							type="button"
							class="tool-btn danger"
							title="Delete permanently"
							disabled={busy}
							onclick={() => run('delete')}
						>
							<Icon name="delete-bin-2-line" size={16} />
						</button>
					{:else}
						<button
							type="button"
							class="tool-btn"
							title="Mark as spam"
							disabled={busy}
							onclick={() => run('spam')}
						>
							<Icon name="spam-2-line" size={16} />
						</button>
						<button
							type="button"
							class="tool-btn"
							title="Move to trash"
							disabled={busy}
							onclick={() => run('trash')}
						>
							<Icon name="delete-bin-line" size={16} />
						</button>
					{/if}

					<OrganizeMenu
						ids={selected}
						inboxIds={selectedInboxIds}
						inInbox={inboxMode === 'mixed' ? false : inboxMode}
						inboxMixed={inboxMode === 'mixed'}
						muted={mutedMode === 'mixed' ? false : mutedMode}
						mutedMixed={mutedMode === 'mixed'}
						important={importantMode === 'mixed' ? false : importantMode}
						importantMixed={importantMode === 'mixed'}
					/>
				</div>
			{:else}
				<h1 class="title">{meta.title}</h1>
				{#if mailbox.total > 0}
					<span class="total">{mailbox.total}</span>
				{/if}
				<span class="title-note skin-only">
					{#if unreadCount > 0}<mark>{unreadCount} unread</mark>{' · '}{/if}{mailbox.total}
					conversation{mailbox.total === 1 ? '' : 's'}
				</span>

				<div class="more">
					<button
						type="button"
						class="tool-btn"
						aria-label="Mailbox actions"
						aria-expanded={moreOpen}
						onclick={() => moreOpen = !moreOpen}
					><Icon name="more-line" size={16} /></button>

					{#if moreOpen}
						<button
							type="button"
							class="backdrop"
							aria-label="Close menu"
							onclick={() => moreOpen = false}
						></button>
						<div class="menu menu-left" role="menu">
							<button type="button" class="menu-item" onclick={() => run('read-all', [])}>
								<Icon name="mail-open-line" size={15} /> Mark all as read
							</button>
							<button type="button" class="menu-item" onclick={() => invalidateAll()}>
								<Icon name="refresh-line" size={15} /> Refresh
							</button>
							{#if view === 'trash'}
								<button
									type="button"
									class="menu-item danger"
									onclick={() => run('empty-trash', [])}
								>
									<Icon name="delete-bin-2-line" size={15} /> Empty trash
								</button>
							{/if}
						</div>
					{/if}
				</div>
			{/if}
		</div>

		<div class="toolbar-right">
			<button
				type="button"
				class="pill"
				class:pill-on={filters.unreadOnly}
				onclick={() => apply({ unread: filters.unreadOnly ? null : '1' })}
			>
				Unread
			</button>

			<div class="filter">
				<button
					type="button"
					class="pill"
					class:pill-on={activeFilterCount > 0}
					aria-expanded={filterOpen}
					onclick={() => filterOpen = !filterOpen}
				>
					<Icon name="equalizer-line" size={14} />
					Filter
					{#if activeFilterCount > 0}<span class="filter-count">{activeFilterCount}</span>{/if}
				</button>

				{#if filterOpen}
					<button
						type="button"
						class="backdrop"
						aria-label="Close filters"
						onclick={() => filterOpen = false}
					></button>
					<div class="menu menu-right" role="menu">
						<button
							type="button"
							class="menu-item"
							onclick={() => apply({ unread: filters.unreadOnly ? null : '1' })}
						>
							<Icon
								name={filters.unreadOnly ? 'checkbox-line' : 'checkbox-blank-line'}
								size={15}
							/>
							Unread only
						</button>
						<button
							type="button"
							class="menu-item"
							onclick={() => apply({ starred: filters.starredOnly ? null : '1' })}
						>
							<Icon
								name={filters.starredOnly ? 'checkbox-line' : 'checkbox-blank-line'}
								size={15}
							/>
							Starred only
						</button>
						<button
							type="button"
							class="menu-item"
							onclick={() => apply({ attachments: filters.attachmentsOnly ? null : '1' })}
						>
							<Icon
								name={filters.attachmentsOnly ? 'checkbox-line' : 'checkbox-blank-line'}
								size={15}
							/>
							Has attachments
						</button>
						{#if activeFilterCount > 0 || filters.q}
							<button
								type="button"
								class="menu-item"
								onclick={() =>
									apply({ unread: null, starred: null, attachments: null, q: null })}
							>
								<Icon name="close-circle-line" size={15} /> Clear all
							</button>
						{/if}
					</div>
				{/if}
			</div>

			<div class="pager">
				<a
					class="pager-btn"
					class:disabled={mailbox.page <= 1}
					href={withParams({ page: mailbox.page - 1 })}
					aria-label="Previous page"
				>
					<Icon name="arrow-left-s-line" size={16} />
				</a>
				<span class="pager-label">{mailbox.page}/{mailbox.pageCount}</span>
				<a
					class="pager-btn"
					class:disabled={mailbox.page >= mailbox.pageCount}
					href={withParams({ page: mailbox.page + 1 })}
					aria-label="Next page"
				>
					<Icon name="arrow-right-s-line" size={16} />
				</a>
			</div>
		</div>
	</header>

	{#if view === 'inbox'}
		<div class="inbox-bar">
			<nav class="tabs" aria-label="Inbox categories">
				{#each CATEGORIES as category (category)}
					<a
						class="tab"
						class:active={activeCategory === category}
						href={withParams({ category })}
						aria-current={activeCategory === category ? 'page' : undefined}
					>
						{CATEGORY_LABELS[category]}
					</a>
				{/each}
			</nav>
			<button
				type="button"
				class="priority"
				role="switch"
				aria-checked={priorityOn}
				disabled={priorityBusy}
				onclick={() => setPriority(!priorityOn)}
			>
				<span class="priority-track" class:on={priorityOn}></span>
				Priority
			</button>
		</div>
	{/if}

	{#if filters.q}
		<div class="search-note">
			<Icon name="search-line" size={14} />
			<span>{mailbox.total} result{mailbox.total === 1 ? '' : 's'} for “{filters.q}”</span>
			<a href={withParams({ q: null })} class="search-clear">Clear</a>
		</div>
	{/if}

	<div class="cols ledger-only" aria-hidden="true">
		<span></span><span>★</span><span>{view === 'sent' || view === 'drafts' || view === 'scheduled' ? 'To' : 'From'}</span>
		<span>Subject</span><span></span><span class="cols-right">Received</span>
	</div>

	<div class="list">
		{#if items.length === 0}
			<EmptyState
				icon={filters.q ? 'search-line' : meta.icon}
				title={filters.q ? 'No messages match that search' : meta.empty}
			/>
		{:else}
			<ul>
				{#each items as thread (thread.thread_id)}
					{@const warning = participantWarning(thread)}
					{#if groups.firstOf.get(dateGroup(thread.created_at)) === thread.thread_id}
						<li class="group-head" aria-hidden="true">
							{dateGroup(thread.created_at)}
							<span class="group-count">· {groups.sizes.get(dateGroup(thread.created_at))}</span>
						</li>
					{/if}
					<li
						class="row"
						class:unread={!thread.is_read}
						class:checked={selected.includes(thread.latest_id)}
						class:selected={selectedThreadId === thread.latest_id}
						data-thread-id={thread.latest_id}
					>
						<input
							type="checkbox"
							class="checkbox"
							aria-label="Select conversation with {people(thread)}"
							checked={selected.includes(thread.latest_id)}
							onchange={() => toggle(thread.latest_id)}
						/>

						<button
							type="button"
							class="star"
							class:on={thread.is_starred}
							data-kb="star"
							aria-label={thread.is_starred ? 'Remove star' : 'Add star'}
							onclick={() => toggleStar(thread)}
						>
							<Icon name={thread.is_starred ? 'star-fill' : 'star-line'} size={15} />
						</button>

						{#if onThreadSelect}
							<button
								type="button"
								class="row-link"
								data-kb="open"
								onclick={() => openThread(thread)}
							>
								<span class="avatar">{initial(thread)}</span>

								<span class="sender" title={people(thread)}>
									<span class="sender-id">
										<span class="sender-names">{people(thread)}</span>
										{#if warning}
											<span class="sender-warning" title={warning}>Name doesn't match sender</span>
										{/if}
									</span>
									{#if thread.message_count > 1}
										<span class="count">{thread.message_count}</span>
									{/if}
									{#if thread.is_draft}<span class="tag tag-draft">Draft</span>{/if}
									{#if thread.is_scheduled}<span class="tag">Scheduled</span>{/if}
								</span>

								<span class="body">
									<span class="subject">{thread.subject || '(no subject)'}</span>
									{#if thread.preview}
										<span class="preview"><span class="dash">{'— '}</span>{thread.preview}</span>
									{/if}
								</span>

								<span class="indicators">
									{#if view === 'sent' && thread.status}
										<DeliveryStatus status={thread.status} />
									{/if}
									{#if thread.has_attachments}
										<Icon name="attachment-2" size={14} />
									{/if}
								</span>

								<span class="date">{formatRelativeDate(thread.created_at)}</span>
							</button>
						{:else}
							<a class="row-link" href={href(thread)} data-kb="open">
								<span class="avatar">{initial(thread)}</span>

								<span class="sender" title={people(thread)}>
									<span class="sender-id">
										<span class="sender-names">{people(thread)}</span>
										{#if warning}
											<span class="sender-warning" title={warning}>Name doesn't match sender</span>
										{/if}
									</span>
									{#if thread.message_count > 1}
										<span class="count">{thread.message_count}</span>
									{/if}
									{#if thread.is_draft}<span class="tag tag-draft">Draft</span>{/if}
									{#if thread.is_scheduled}<span class="tag">Scheduled</span>{/if}
								</span>

								<span class="body">
									<span class="subject">{thread.subject || '(no subject)'}</span>
									{#if thread.preview}
										<span class="preview"><span class="dash">{'— '}</span>{thread.preview}</span>
									{/if}
								</span>

								<span class="indicators">
									{#if view === 'sent' && thread.status}
										<DeliveryStatus status={thread.status} />
									{/if}
									{#if thread.has_attachments}
										<Icon name="attachment-2" size={14} />
									{/if}
								</span>

								<span class="date">{formatRelativeDate(thread.created_at)}</span>
							</a>
						{/if}

						{#if thread.labels.length > 0}
							<div class="row-labels">
								<OrganizeMenu
									ids={[thread.latest_id]}
									labels={thread.labels}
									showMenu={false}
									showChips
								/>
							</div>
						{/if}

						<span class="row-actions">
							{#if view === 'trash'}
								<button
									type="button"
									class="tool-btn"
									title="Restore"
									onclick={() => run('restore', [thread.latest_id])}
								>
									<Icon name="arrow-go-back-line" size={15} />
								</button>
								<button
									type="button"
									class="tool-btn danger"
									title="Delete permanently"
									onclick={() => run('delete', [thread.latest_id])}
								>
									<Icon name="delete-bin-2-line" size={15} />
								</button>
							{:else if view === 'spam'}
								<button
									type="button"
									class="tool-btn"
									title="Not spam"
									data-kb="spam"
									onclick={() => run('unspam', [thread.latest_id])}
								>
									<Icon name="mail-check-line" size={15} />
								</button>
								<button
									type="button"
									class="tool-btn danger"
									title="Delete permanently"
									onclick={() => run('delete', [thread.latest_id])}
								>
									<Icon name="delete-bin-2-line" size={15} />
								</button>
							{:else}
								{#if thread.is_scheduled}
									<button
										type="button"
										class="tool-btn cancel"
										title="Cancel"
										aria-label="Cancel"
										onclick={() => cancelScheduled(thread)}
									>
										Cancel
									</button>
								{/if}
								<button
									type="button"
									class="tool-btn"
									title={thread.is_read ? 'Mark as unread' : 'Mark as read'}
									onclick={() => run(thread.is_read ? 'unread' : 'read', [thread.latest_id])}
								>
									<Icon name={thread.is_read ? 'mail-line' : 'mail-open-line'} size={15} />
								</button>
								<button
									type="button"
									class="tool-btn"
									title="Mark as spam"
									data-kb="spam"
									onclick={() => run('spam', [thread.latest_id])}
								>
									<Icon name="spam-2-line" size={15} />
								</button>
								<button
									type="button"
									class="tool-btn"
									title="Move to trash"
									data-kb="trash"
									onclick={() => run('trash', [thread.latest_id])}
								>
									<Icon name="delete-bin-line" size={15} />
								</button>
							{/if}
						</span>
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	{#if mailbox.total > 0}
		<footer class="list-foot">
			<span>{rangeStart}–{rangeEnd} of {mailbox.total}</span>
		</footer>
	{/if}
</section>

<style>
	.mailbox {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		height: 100%;
		background: var(--color-surface);
		border-radius: 0.5rem;
		box-shadow: var(--shadow-xs);
		border: 1px solid var(--color-line);
		overflow: hidden;
	}

	/* --- toolbar --- */

	.toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.5rem 1rem;
		box-shadow: inset 0 -1px 0 var(--color-line);
		min-height: 3rem;
	}

	.toolbar-left,
	.toolbar-right {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-width: 0;
	}

	.title {
		font-size: 1.25rem;
		font-weight: 400;
		letter-spacing: 0;
		color: var(--color-text);
	}

	.total {
		font-size: 0.875rem;
		color: var(--color-text-secondary);
	}

	.selected-count {
		font-size: 0.875rem;
		font-weight: 400;
		color: var(--color-text);
	}

	.bulk-actions {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}

	.select-all {
		position: relative;
		display: flex;
		align-items: center;
		gap: 0.125rem;
		padding-right: 0.25rem;
	}

	.caret {
		display: flex;
		align-items: center;
		color: var(--color-muted);
	}

	.caret:hover {
		color: var(--color-text);
	}

	.checkbox {
		width: 1.125rem;
		height: 1.125rem;
		flex-shrink: 0;
		border-radius: 0.125rem;
		accent-color: var(--color-link);
		cursor: pointer;
	}

	.tool-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 50%;
		color: var(--color-text-secondary);
		transition: background 0.2s, color 0.2s;
	}

	.tool-btn:hover:not(:disabled) {
		background: var(--color-surface-hover);
		color: var(--color-text);
	}

	.tool-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.tool-btn.danger:hover {
		color: var(--color-danger);
	}

	.tool-btn.cancel {
		width: auto;
		padding: 0 0.75rem;
		border-radius: 999px;
		font-size: 0.75rem;
		font-weight: 650;
	}

	.more,
	.filter {
		position: relative;
	}

	.pill {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		height: 2rem;
		padding: 0 0.875rem;
		border-radius: 1rem;
		font-size: 0.875rem;
		color: var(--color-text-secondary);
		background: var(--color-surface);
		box-shadow: inset 0 0 0 1px var(--color-line);
		transition: background 0.2s, color 0.2s, box-shadow 0.2s;
	}

	.pill:hover {
		background: var(--color-surface-hover);
		color: var(--color-text);
	}

	.pill-on {
		color: var(--color-text);
		font-weight: 500;
		background: var(--color-surface-hover);
		box-shadow: inset 0 0 0 1px transparent;
	}

	.filter-count {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.125rem;
		height: 1.125rem;
		padding: 0 0.25rem;
		border-radius: 0.5rem;
		font-size: 0.625rem;
		font-weight: 700;
		color: var(--color-text);
		background: var(--color-surface-hover);
	}

	.pager {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}

	.pager-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 50%;
		color: var(--color-text-secondary);
		transition: background 0.2s;
	}

	.pager-btn:hover {
		background: var(--color-surface-hover);
	}

	.pager-btn.disabled {
		pointer-events: none;
		color: var(--color-muted);
		opacity: 0.4;
	}

	.pager-label {
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		white-space: nowrap;
		padding: 0 0.25rem;
	}

	/* --- dropdown menus --- */

	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 20;
	}

	.menu {
		position: absolute;
		top: calc(100% + 0.5rem);
		z-index: 30;
		min-width: 12rem;
		padding: 0.5rem;
		background: var(--color-surface);
		border-radius: 0.5rem;
		box-shadow: var(--shadow-md);
		border: 1px solid var(--color-line);
	}

	.menu-left {
		left: 0;
	}

	.menu-right {
		right: 0;
	}

	.menu-item {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
		padding: 0.625rem 0.75rem;
		border-radius: 0.25rem;
		font-size: 0.875rem;
		color: var(--color-text);
		text-align: left;
		transition: background 0.15s;
	}

	.menu-item:hover {
		background: var(--color-surface-hover);
	}

	.menu-item.danger:hover {
		color: var(--color-danger);
	}

	/* --- search note --- */

	.search-note {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem 1rem;
		font-size: 0.875rem;
		color: var(--color-text);
		background: var(--color-surface-muted);
		box-shadow: inset 0 -1px 0 var(--color-line);
	}

	.search-clear {
		margin-left: auto;
		font-size: 0.875rem;
		color: var(--color-link);
		text-decoration: none;
		font-weight: 500;
	}

	.search-clear:hover {
		text-decoration: underline;
	}

	.list {
		flex: 1;
		min-height: 0;
		overflow: auto;
	}

	/* --- rows --- */

	/* Date dividers and the Ledger column header belong to the paper skins. */
	.group-head,
	.cols {
		display: none;
	}

	.row {
		position: relative;
		display: grid;
		grid-template-columns: auto auto 1fr;
		align-items: center;
		gap: 0.75rem;
		padding: 0 1rem;
		background: var(--color-surface);
		box-shadow: inset 0 -1px 0 var(--color-line);
		transition: background 0.15s, box-shadow 0.15s;
	}

	.row:last-child {
		box-shadow: none;
	}

	.row.unread {
		background: var(--color-surface);
	}

	.row:hover,
	.row.unread:hover {
		background: var(--color-surface-hover);
		box-shadow: inset 1px 0 0 #dadce0, inset -1px 0 0 #dadce0, 0 1px 2px 0 rgba(60, 64, 67, 0.3),
			0 1px 3px 1px rgba(60, 64, 67, 0.15);
		z-index: 1;
	}

	.row.checked,
	.row.checked:hover {
		background: var(--color-accent-soft);
	}

	.row.selected,
	.row.selected:hover {
		background: var(--color-accent-soft);
		box-shadow: inset 3px 0 0 var(--color-link);
	}

	.star {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: 50%;
		color: var(--color-text-secondary);
		transition: color 0.15s;
	}

	.star:hover {
		color: var(--color-text);
	}

	.star.on {
		color: var(--color-star);
	}

	.row-link {
		display: grid;
		grid-template-columns: minmax(8rem, 12rem) minmax(0, 1fr) auto 5rem;
		align-items: center;
		gap: 1rem;
		min-width: 0;
		padding: 0.75rem 0;
		width: 100%;
		text-align: left;
		background: none;
		border: none;
		cursor: pointer;
	}

	.avatar {
		display: none;
	}

	.row.unread .avatar {
		display: none;
	}

	.sender {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		font-size: 0.875rem;
		color: var(--color-text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-transform: capitalize;
	}

	.row.unread .sender {
		font-weight: 700;
		color: var(--color-text);
	}

	.sender:has(.sender-warning) {
		align-items: flex-start;
	}

	.sender-id {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		min-width: 0;
		overflow: hidden;
	}

	.sender-names {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.sender-warning {
		margin-top: 0.125rem;
		font-size: 0.75rem;
		font-weight: 400;
		line-height: 1.35;
		color: var(--tone-warn-fg);
		text-transform: none;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.count {
		flex-shrink: 0;
		font-size: 0.8125rem;
		font-weight: 400;
		color: var(--color-text-secondary);
	}

	.row.unread .count {
		font-weight: 500;
		color: var(--color-text);
	}

	.body {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
	}

	.subject {
		font-size: 0.875rem;
		color: var(--color-text);
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.row.unread .subject {
		font-weight: 700;
		color: var(--color-text);
	}

	.preview {
		flex: 1;
		min-width: 0;
		font-size: 0.875rem;
		color: var(--color-text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.indicators {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-shrink: 0;
		color: var(--color-text-secondary);
	}

	.tag {
		padding: 0.125rem 0.5rem;
		border-radius: 0.25rem;
		font-size: 0.6875rem;
		font-weight: 500;
		color: var(--color-text-secondary);
		background: var(--color-surface-hover);
		white-space: nowrap;
	}

	.tag-draft {
		color: var(--color-danger);
		background: var(--color-accent-soft);
	}

	.date {
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		text-align: right;
		white-space: nowrap;
	}

	.row.unread .date {
		font-weight: 700;
		color: var(--color-text);
	}

	.row-actions {
		position: absolute;
		top: 50%;
		right: 1rem;
		z-index: 5;
		display: none;
		align-items: center;
		gap: 0.25rem;
		padding-left: 2rem;
		transform: translateY(-50%);
		background: linear-gradient(
			to right,
			transparent,
			var(--color-surface-hover) 2rem,
			var(--color-surface-hover)
		);
	}

	.row:hover .row-actions {
		display: flex;
	}

	.list-foot {
		display: flex;
		justify-content: flex-end;
		padding: 0.75rem 1rem;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		box-shadow: inset 0 1px 0 var(--color-line);
	}

	.inbox-bar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0 0.75rem 0 0.25rem;
		box-shadow: inset 0 -1px 0 var(--color-line);
	}

	.tabs {
		display: flex;
		align-items: stretch;
		min-width: 0;
		flex: 1;
		overflow-x: auto;
	}

	.tab {
		padding: 0.75rem 0.75rem 0.625rem;
		font-size: 0.875rem;
		color: var(--color-text-secondary);
		text-decoration: none;
		border-bottom: 2px solid transparent;
		white-space: nowrap;
	}

	.tab:hover {
		color: var(--color-text);
	}

	.tab.active {
		color: var(--color-link);
		font-weight: 600;
		border-bottom-color: var(--color-link);
	}

	.priority {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		flex-shrink: 0;
		padding: 0.375rem 0.25rem 0.375rem 0.75rem;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		white-space: nowrap;
	}

	.priority:hover:not(:disabled) {
		color: var(--color-text);
	}

	.priority:disabled {
		opacity: 0.6;
	}

	.priority-track {
		position: relative;
		width: 1.75rem;
		height: 1rem;
		border-radius: 9999px;
		background: var(--color-line);
	}

	.priority-track::after {
		content: '';
		position: absolute;
		top: 0.125rem;
		left: 0.125rem;
		width: 0.75rem;
		height: 0.75rem;
		border-radius: 9999px;
		background: #fff;
		transition: transform 0.15s;
	}

	.priority-track.on {
		background: var(--color-link);
	}

	.priority-track.on::after {
		transform: translateX(0.75rem);
	}

	.row-labels {
		position: absolute;
		right: 10.5rem;
		top: 50%;
		z-index: 2;
		max-width: 36%;
		transform: translateY(-50%);
	}

	.row:has(.row-labels) .body {
		padding-right: 11rem;
	}

	@media (max-width: 780px) {
		.row-link {
			grid-template-columns: minmax(0, 1fr) auto;
			grid-template-areas:
				'sender date'
				'body body';
			gap: 0.25rem 0.5rem;
		}

		.avatar,
		.indicators {
			display: none;
		}

		.sender {
			grid-area: sender;
		}

		.date {
			grid-area: date;
		}

		.body {
			grid-area: body;
		}

		.row-actions {
			display: none !important;
		}

		.row-labels {
			position: static;
			transform: none;
			max-width: none;
			grid-column: 1 / -1;
			margin: 0 0 0.35rem 2.75rem;
		}

		.row:has(.row-labels) .body {
			padding-right: 0;
		}

		.title {
			font-size: 0.9375rem;
		}
	}
</style>
