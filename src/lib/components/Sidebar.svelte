<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/stores';
	import Icon from './Icon.svelte';
	import Logo from './Logo.svelte';
	import DomainSwitcher from './DomainSwitcher.svelte';
	import { LABEL_COLORS, type LabelColor } from '$lib/organizing/labels';
	import type { Domain, MailboxCounts } from '$lib/types';

	type SidebarLabel = {
		id: string;
		parentId: string | null;
		name: string;
		color: LabelColor;
		unread: number;
	};

	let {
		counts,
		labels = [],
		domains,
		activeDomainId,
		isAdmin,
		account = '',
		collapsed = $bindable(false),
		mobileOpen = $bindable(false),
		onCompose
	}: {
		counts: MailboxCounts;
		labels?: SidebarLabel[];
		domains: Domain[];
		activeDomainId: string | null;
		isAdmin: boolean;
		/** Sending address shown under the brand in the paper skins. */
		account?: string;
		collapsed?: boolean;
		mobileOpen?: boolean;
		onCompose?: () => void;
	} = $props();

	type NavItem = {
		href: string;
		icon: string;
		label: string;
		/** Bold pill (unread) vs. plain total. */
		badge?: number;
		count?: number;
	};

	const mailboxes = $derived<NavItem[]>([
		{ href: '/inbox', icon: 'inbox-line', label: 'Inbox', badge: counts.inbox_unread },
		{ href: '/all', icon: 'archive-line', label: 'All Mail', count: counts.all },
		{ href: '/starred', icon: 'star-line', label: 'Starred', count: counts.starred },
		{ href: '/sent', icon: 'send-plane-line', label: 'Sent' },
		{ href: '/drafts', icon: 'draft-line', label: 'Drafts', count: counts.drafts },
		{ href: '/spam', icon: 'spam-2-line', label: 'Spam', count: counts.spam },
		{ href: '/trash', icon: 'delete-bin-line', label: 'Trash', count: counts.trash },
		{ href: '/snoozed', icon: 'time-line', label: 'Snoozed', count: counts.snoozed },
		{ href: '/scheduled', icon: 'time-line', label: 'Scheduled', count: counts.scheduled }
	]);

	/** Parents first, then their children. Root depth is 0. */
	const labelRows = $derived.by(() => {
		const ids = new Set(labels.map((label) => label.id));
		const children = new Map<string | null, SidebarLabel[]>();
		for (const label of labels) {
			const parentId = label.parentId && ids.has(label.parentId) ? label.parentId : null;
			const list = children.get(parentId) ?? [];
			list.push(label);
			children.set(parentId, list);
		}

		const rows: { label: SidebarLabel; depth: number }[] = [];
		const seen = new Set<string>();
		function walk(parentId: string | null, depth: number) {
			for (const label of children.get(parentId) ?? []) {
				if (seen.has(label.id)) continue;
				seen.add(label.id);
				rows.push({ label, depth });
				walk(label.id, depth + 1);
			}
		}
		walk(null, 0);
		return rows;
	});

	const LABEL_WRITE_ERRORS: Record<string, string> = {
		duplicate: 'A label with that name already exists here.',
		cycle: 'That parent would create a cycle.',
		depth: 'Labels can only be nested five levels deep.',
		color: 'Pick a label color.',
		parent: 'That parent label is not available.',
		'Demo mode is read-only': 'Demo mode is read-only.'
	};

	let creating = $state(false);
	let draftName = $state('');
	let draftParentId = $state('');
	let draftColor = $state<LabelColor>('blue');
	let draftError = $state('');
	let draftBusy = $state(false);
	let nameInput = $state<HTMLInputElement | null>(null);

	let editingId = $state<string | null>(null);
	let editName = $state('');
	let editParentId = $state('');
	let editColor = $state<LabelColor>('blue');
	let editError = $state('');
	let editBusy = $state(false);
	let editNameInput = $state<HTMLInputElement | null>(null);
	let deleteError = $state('');

	$effect(() => {
		if (creating) nameInput?.focus();
	});

	$effect(() => {
		if (editingId) editNameInput?.focus();
	});

	function labelWriteError(code: unknown, fallback = 'Could not create that label.'): string {
		if (typeof code === 'string' && LABEL_WRITE_ERRORS[code]) return LABEL_WRITE_ERRORS[code];
		return fallback;
	}

	async function createLabel(event: SubmitEvent) {
		event.preventDefault();
		const name = draftName.trim();
		if (!name) {
			draftError = 'Enter a name.';
			return;
		}

		draftBusy = true;
		draftError = '';
		try {
			const res = await fetch('/api/labels', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name,
					parentId: draftParentId || null,
					color: draftColor
				})
			});
			const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
			if (!res.ok) {
				draftError = labelWriteError(body?.error);
				return;
			}
			draftName = '';
			draftParentId = '';
			draftColor = 'blue';
			creating = false;
			await invalidateAll();
		} catch {
			draftError = 'Could not create that label.';
		} finally {
			draftBusy = false;
		}
	}

	function startCreate() {
		editingId = null;
		editError = '';
		creating = true;
	}

	function startEdit(label: SidebarLabel) {
		creating = false;
		draftError = '';
		deleteError = '';
		editingId = label.id;
		editName = label.name;
		editParentId = label.parentId ?? '';
		editColor = label.color;
		editError = '';
	}

	function cancelEdit() {
		editingId = null;
		editError = '';
	}

	async function saveEdit(event: SubmitEvent) {
		event.preventDefault();
		const id = editingId;
		if (!id) return;
		const name = editName.trim();
		if (!name) {
			editError = 'Enter a name.';
			return;
		}

		editBusy = true;
		editError = '';
		try {
			const res = await fetch(`/api/labels/${id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name,
					parentId: editParentId || null,
					color: editColor
				})
			});
			const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
			if (!res.ok) {
				if (editingId === id) editError = labelWriteError(body?.error, 'Could not save that label.');
				return;
			}
			if (editingId === id) editingId = null;
			await invalidateAll();
		} catch {
			if (editingId === id) editError = 'Could not save that label.';
		} finally {
			editBusy = false;
		}
	}

	async function deleteLabel(label: SidebarLabel) {
		deleteError = '';
		if (!confirm(`Delete ${label.name}? Its sublabels go with it. The messages stay.`)) return;

		try {
			const res = await fetch(`/api/labels/${label.id}`, { method: 'DELETE' });
			const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
			if (!res.ok) {
				deleteError = labelWriteError(body?.error, 'Could not delete that label.');
				return;
			}
			if (editingId === label.id) editingId = null;
			await invalidateAll();
		} catch {
			deleteError = 'Could not delete that label.';
		}
	}

	const tools = $derived<NavItem[]>([
		{ href: '/staff', icon: 'team-line', label: 'Staff' },
		{ href: '/settings', icon: 'user-settings-line', label: 'Settings' },
		...(isAdmin ? [{ href: '/admin', icon: 'settings-3-line', label: 'Admin' }] : [])
	]);

	function isActive(href: string): boolean {
		return $page.url.pathname === href || $page.url.pathname.startsWith(`${href}/`);
	}
</script>

{#if mobileOpen}
	<button
		type="button"
		class="scrim"
		aria-label="Close navigation"
		onclick={() => (mobileOpen = false)}
	></button>
{/if}

<aside class="sidebar" class:collapsed class:mobile-open={mobileOpen}>
	<div class="sidebar-top">
		<a href="/inbox" class="brand" title="CloudMail">
			<Logo size={30} class="brand-mark" />
			{#if !collapsed}
				<span class="brand-text">
					<span class="brand-name"><span class="brand-cloud">Cloud</span>Mail</span>
					{#if account}<span class="brand-account">{account}</span>{/if}
				</span>
			{/if}
		</a>
	</div>

	<button type="button" class="new-message" title="New message" onclick={onCompose}>
		<Icon name="pencil-line" size={collapsed ? 18 : 18} />
		{#if !collapsed}<span>Compose</span><kbd class="kb-hint">c</kbd>{/if}
	</button>

	{#if !collapsed}<p class="section-title nav-title skin-only">Mailboxes</p>{/if}
	<nav class="nav nav-mailboxes">
		{#each mailboxes as item (item.href)}
			<a
				href={item.href}
				class="nav-link"
				class:active={isActive(item.href)}
				title={collapsed ? item.label : undefined}
				onclick={() => (mobileOpen = false)}
			>
				<Icon name={item.icon} size={17} />
				{#if !collapsed}
					<span class="nav-label">{item.label}</span>
					{#if item.badge}
						<span class="nav-badge">{item.badge}</span>
					{:else if item.count}
						<span class="nav-count">{item.count}</span>
					{/if}
				{:else if item.badge}
					<span class="nav-dot"></span>
				{/if}
			</a>
		{/each}
	</nav>

	{#if !collapsed}
		<div class="section">
			<p class="section-title">Labels</p>
			<nav class="nav label-tree" aria-label="Labels">
				{#each labelRows as row (row.label.id)}
					{#if editingId === row.label.id}
						<form class="label-form" onsubmit={saveEdit}>
							<label class="label-field">
								<span class="label-field-name">Name</span>
								<input
									class="label-input"
									bind:this={editNameInput}
									bind:value={editName}
									required
									autocomplete="off"
								/>
							</label>
							<label class="label-field">
								<span class="label-field-name">Parent</span>
								<select class="label-input" bind:value={editParentId}>
									<option value="">No parent</option>
									{#each labelRows as option (option.label.id)}
										{#if option.label.id !== row.label.id}
											<option value={option.label.id}>
												{`${'\u2014 '.repeat(option.depth)}${option.label.name}`}
											</option>
										{/if}
									{/each}
								</select>
							</label>
							<div class="label-field">
								<span class="label-field-name" id="edit-label-color">Color</span>
								<div class="color-choices" role="group" aria-labelledby="edit-label-color">
									{#each LABEL_COLORS as color (color)}
										<button
											type="button"
											class="color-choice"
											data-color={color}
											aria-label={color}
											aria-pressed={editColor === color}
											onclick={() => (editColor = color)}
										></button>
									{/each}
								</div>
							</div>
							{#if editError}<p class="label-error">{editError}</p>{/if}
							<div class="label-actions">
								<button type="submit" class="label-submit" disabled={editBusy}>Save</button>
								<button type="button" class="label-cancel" onclick={cancelEdit}>Cancel</button>
							</div>
						</form>
					{:else}
						<div class="label-row">
							<a
								href="/labels/{row.label.id}"
								class="nav-link"
								class:active={$page.url.pathname === `/labels/${row.label.id}`}
								onclick={() => (mobileOpen = false)}
							>
								<span class="label-indent" style:padding-left="{row.depth * 0.75}rem">
									<span class="label-dot" data-color={row.label.color}></span>
									<span class="nav-label">{row.label.name}</span>
								</span>
								{#if row.label.unread > 0}
									<span class="nav-count">{row.label.unread}</span>
								{/if}
							</a>
							<button
								type="button"
								class="label-row-btn"
								aria-label="Edit {row.label.name}"
								onclick={() => startEdit(row.label)}
							>
								<Icon name="pencil-line" size={14} />
							</button>
							<button
								type="button"
								class="label-row-btn label-row-delete"
								aria-label="Delete {row.label.name}"
								onclick={() => deleteLabel(row.label)}
							>
								<Icon name="delete-bin-line" size={14} />
							</button>
						</div>
					{/if}
				{/each}
			</nav>
			{#if deleteError}<p class="label-error label-delete-error">{deleteError}</p>{/if}

			{#if creating}
				<form class="label-form" onsubmit={createLabel}>
					<label class="label-field">
						<span class="label-field-name">Name</span>
						<input
							class="label-input"
							bind:this={nameInput}
							bind:value={draftName}
							required
							autocomplete="off"
						/>
					</label>
					<label class="label-field">
						<span class="label-field-name">Parent</span>
						<select class="label-input" bind:value={draftParentId}>
							<option value="">No parent</option>
							{#each labelRows as row (row.label.id)}
								<option value={row.label.id}>
									{`${'\u2014 '.repeat(row.depth)}${row.label.name}`}
								</option>
							{/each}
						</select>
					</label>
					<div class="label-field">
						<span class="label-field-name" id="new-label-color">Color</span>
						<div class="color-choices" role="group" aria-labelledby="new-label-color">
							{#each LABEL_COLORS as color (color)}
								<button
									type="button"
									class="color-choice"
									data-color={color}
									aria-label={color}
									aria-pressed={draftColor === color}
									onclick={() => (draftColor = color)}
								></button>
							{/each}
						</div>
					</div>
					{#if draftError}<p class="label-error">{draftError}</p>{/if}
					<div class="label-actions">
						<button type="submit" class="label-submit" disabled={draftBusy}>New label</button>
						<button
							type="button"
							class="label-cancel"
							onclick={() => {
								creating = false;
								draftError = '';
							}}
						>
							Cancel
						</button>
					</div>
				</form>
			{:else if !editingId}
				<button type="button" class="new-label" onclick={startCreate}>
					<Icon name="add-line" size={15} />
					New label
				</button>
			{/if}
		</div>
	{/if}

	{#if !collapsed && domains.length > 0}
		<div class="section">
			<p class="section-title">Domains</p>
			<div class="section-body">
				<DomainSwitcher {domains} {activeDomainId} block />
			</div>
		</div>
	{/if}

	<nav class="nav nav-tools">
		{#each tools as item (item.href)}
			<a
				href={item.href}
				class="nav-link"
				class:active={isActive(item.href)}
				title={collapsed ? item.label : undefined}
				onclick={() => (mobileOpen = false)}
			>
				<Icon name={item.icon} size={17} />
				{#if !collapsed}<span class="nav-label">{item.label}</span>{/if}
			</a>
		{/each}
	</nav>

	<div class="sidebar-foot">
		<button
			type="button"
			class="collapse-btn"
			aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
			onclick={() => (collapsed = !collapsed)}
		>
			<Icon name={collapsed ? 'arrow-right-double-line' : 'arrow-left-double-line'} size={15} />
		</button>
	</div>
</aside>

<style>
	.sidebar {
		position: fixed;
		top: 0;
		left: 0;
		bottom: 0;
		z-index: 40;
		display: flex;
		flex-direction: column;
		width: var(--sidebar-width);
		padding: 0.875rem 0.75rem 0.75rem;
		background: var(--color-surface);
		box-shadow: inset -1px 0 0 var(--color-line);
		overflow-x: hidden;
		overflow-y: auto;
		transition: width 0.18s ease, transform 0.18s ease;
	}

	.sidebar.collapsed {
		width: var(--sidebar-width-collapsed);
		padding-left: 0.5rem;
		padding-right: 0.5rem;
	}

	.sidebar-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 0.25rem 0.875rem;
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.9375rem;
		font-weight: 600;
		letter-spacing: -0.02em;
		color: var(--color-text);
	}

	.brand-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
		line-height: 1.15;
	}

	.brand-account {
		display: none;
	}

	.new-message {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.4375rem;
		height: 2.5rem;
		margin-bottom: 1rem;
		border-radius: 0.75rem;
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--color-on-accent);
		background: var(--color-accent);
		box-shadow: var(--shadow-xs);
		transition: background 0.15s;
	}

	.new-message:hover {
		background: var(--color-accent-hover);
	}

	.nav {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}

	.nav-tools {
		margin-top: 0.75rem;
		padding-top: 0.75rem;
		box-shadow: inset 0 1px 0 var(--color-line);
	}

	.nav-link {
		position: relative;
		display: flex;
		align-items: center;
		gap: 0.625rem;
		height: 2.25rem;
		padding: 0 0.625rem;
		border-radius: 0.625rem;
		font-size: 0.875rem;
		color: var(--color-text-secondary);
		transition: background 0.15s, color 0.15s;
	}

	.sidebar.collapsed .nav-link {
		justify-content: center;
		padding: 0;
	}

	.nav-link:hover {
		background: var(--color-surface-muted);
		color: var(--color-text);
	}

	.nav-link.active {
		background: var(--color-surface-hover);
		color: var(--color-text);
		font-weight: 500;
	}

	.nav-label {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.nav-badge {
		min-width: 1.25rem;
		padding: 0.0625rem 0.375rem;
		border-radius: 9999px;
		font-size: 0.6875rem;
		font-weight: 600;
		text-align: center;
		color: var(--color-on-accent);
		background: var(--color-accent);
	}

	.nav-count {
		font-size: 0.75rem;
		color: var(--color-muted);
	}

	.nav-dot {
		position: absolute;
		top: 0.4375rem;
		right: 0.6875rem;
		width: 0.4375rem;
		height: 0.4375rem;
		border-radius: 9999px;
		background: var(--color-accent);
	}

	.section {
		margin-top: 1.125rem;
	}

	.section-title {
		padding: 0 0.625rem;
		font-size: 0.6875rem;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--color-muted);
	}

	.section-body {
		margin-top: 0.375rem;
	}

	.label-tree {
		margin-top: 0.375rem;
	}

	.label-row {
		display: flex;
		align-items: center;
		gap: 0.125rem;
	}

	.label-row .nav-link {
		flex: 1;
		min-width: 0;
		padding-right: 0.25rem;
	}

	.label-row-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 0.375rem;
		color: var(--color-muted);
	}

	.label-row-btn:hover {
		background: var(--color-surface-muted);
		color: var(--color-text);
	}

	.label-row-delete:hover {
		color: var(--color-danger);
	}

	.label-delete-error {
		margin: 0.375rem 0.625rem 0;
	}

	.label-indent {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		flex: 1;
		min-width: 0;
	}

	.label-indent .nav-label {
		min-width: 0;
	}

	.label-dot,
	.color-choice {
		flex-shrink: 0;
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 9999px;
		background: var(--color-muted);
	}

	.label-dot[data-color='slate'],
	.color-choice[data-color='slate'] {
		background: #5f6368;
	}

	.label-dot[data-color='red'],
	.color-choice[data-color='red'] {
		background: #d93025;
	}

	.label-dot[data-color='orange'],
	.color-choice[data-color='orange'] {
		background: #e37400;
	}

	.label-dot[data-color='amber'],
	.color-choice[data-color='amber'] {
		background: #f9ab00;
	}

	.label-dot[data-color='green'],
	.color-choice[data-color='green'] {
		background: #188038;
	}

	.label-dot[data-color='blue'],
	.color-choice[data-color='blue'] {
		background: #1a73e8;
	}

	.label-dot[data-color='violet'],
	.color-choice[data-color='violet'] {
		background: #9334e6;
	}

	.label-dot[data-color='pink'],
	.color-choice[data-color='pink'] {
		background: #d01884;
	}

	.new-label {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		height: 2rem;
		margin-top: 0.25rem;
		padding: 0 0.625rem;
		border-radius: 0.625rem;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.new-label:hover {
		background: var(--color-surface-muted);
		color: var(--color-text);
	}

	.label-form {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-top: 0.375rem;
		padding: 0.625rem;
		border-radius: 0.625rem;
		background: var(--color-surface-muted);
	}

	.label-field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.label-field-name {
		font-size: 0.6875rem;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--color-muted);
	}

	.label-input {
		width: 100%;
		height: 2rem;
		padding: 0 0.5rem;
		border-radius: 0.375rem;
		font-size: 0.8125rem;
		color: var(--color-text);
		background: var(--color-surface);
		box-shadow: inset 0 0 0 1px var(--color-line);
		outline: none;
	}

	.label-input:focus {
		box-shadow: inset 0 0 0 1px var(--color-focus-line), 0 0 0 3px var(--color-focus-halo);
	}

	.color-choices {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
	}

	.color-choice {
		width: 1.125rem;
		height: 1.125rem;
		box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
	}

	.color-choice[aria-pressed='true'] {
		box-shadow: 0 0 0 2px var(--color-surface), 0 0 0 3.5px var(--color-text);
	}

	.label-error {
		font-size: 0.75rem;
		color: var(--color-danger);
	}

	.label-actions {
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}

	.label-submit,
	.label-cancel {
		height: 1.75rem;
		padding: 0 0.625rem;
		border-radius: 9999px;
		font-size: 0.75rem;
		font-weight: 500;
	}

	.label-submit {
		color: var(--color-on-accent);
		background: var(--color-accent);
	}

	.label-submit:disabled {
		opacity: 0.5;
	}

	.label-cancel {
		color: var(--color-text-secondary);
	}

	.label-cancel:hover {
		color: var(--color-text);
	}

	.sidebar-foot {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: auto;
		padding-top: 0.75rem;
	}

	.collapse-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 1.875rem;
		height: 1.875rem;
		margin-left: auto;
		border-radius: 0.5rem;
		color: var(--color-muted);
		background: var(--color-surface-muted);
		transition: background 0.15s, color 0.15s;
	}

	.collapse-btn:hover {
		background: var(--color-surface-hover);
		color: var(--color-text);
	}

	.scrim {
		position: fixed;
		inset: 0;
		z-index: 35;
		background: var(--color-scrim);
	}

	@media (max-width: 900px) {
		.sidebar {
			transform: translateX(-100%);
			box-shadow: var(--shadow-md);
		}

		.sidebar.mobile-open {
			transform: none;
		}

		.scrim {
			display: block;
		}
	}

	@media (min-width: 901px) {
		.scrim {
			display: none;
		}
	}
</style>
