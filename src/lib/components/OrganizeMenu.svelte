<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import Icon from './Icon.svelte';
	import { showToast } from '#lib/toast.ts';
	import { CATEGORIES, isMailCategory, type MailCategory } from '#lib/organizing/categories.ts';
	import { inboxUndoTargets } from '#lib/organizing/inbox-undo.ts';
	import { isFutureInstant, snoozeInstant, type SnoozePreset } from '#lib/organizing/snooze.ts';

	type Chip = { id: string; name: string; color: string };

	type ApiLabel = {
		id: string;
		parentId: string | null;
		name: string;
		color: string;
	};

	const CATEGORY_LABELS: Record<MailCategory, string> = {
		primary: 'Primary',
		social: 'Social',
		promotions: 'Promotions',
		updates: 'Updates',
		forums: 'Forums'
	};

	const SNOOZE_PRESETS: { id: SnoozePreset; label: string }[] = [
		{ id: 'later', label: 'Later today' },
		{ id: 'tomorrow', label: 'Tomorrow' },
		{ id: 'next-week', label: 'Next week' }
	];

	let {
		ids,
		inInbox = true,
		inboxMixed = false,
		inboxIds,
		muted = false,
		mutedMixed = false,
		important = false,
		importantMixed = false,
		category = null,
		labels = [],
		showMenu = true,
		showChips = false,
		labeled = false,
		align = 'left',
		onChanged
	}: {
		ids: string[];
		inInbox?: boolean;
		inboxMixed?: boolean;
		/** Selected ids that were in the inbox. Omit when the selection is uniform. */
		inboxIds?: string[];
		muted?: boolean;
		mutedMixed?: boolean;
		important?: boolean;
		importantMixed?: boolean;
		category?: string | null;
		labels?: Chip[];
		showMenu?: boolean;
		showChips?: boolean;
		labeled?: boolean;
		align?: 'left' | 'right';
		onChanged?: () => void | Promise<void>;
	} = $props();

	let open = $state(false);
	let busy = $state(false);
	let catalog = $state<ApiLabel[]>([]);
	let labelsLoaded = $state(false);
	let customWhen = $state('');
	let newName = $state('');

	const showArchive = $derived(inInbox || inboxMixed);
	const showMoveToInbox = $derived(!inInbox || inboxMixed);
	const showUnmute = $derived(muted || mutedMixed);
	const showMute = $derived(!muted || mutedMixed);
	const showNotImportant = $derived(important || importantMixed);
	const showImportant = $derived(!important || importantMixed);
	const currentCategory = $derived(isMailCategory(category) ? category : null);

	const labelRows = $derived.by(() => {
		const known = new Set(catalog.map((label) => label.id));
		const children = new Map<string | null, ApiLabel[]>();
		for (const label of catalog) {
			const parentId = label.parentId && known.has(label.parentId) ? label.parentId : null;
			const list = children.get(parentId) ?? [];
			list.push(label);
			children.set(parentId, list);
		}
		const rows: { label: ApiLabel; depth: number }[] = [];
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

	function errorText(body: unknown, fallback: string): string {
		if (
			body &&
			typeof body === 'object' &&
			'error' in body &&
			typeof body.error === 'string' &&
			body.error
		) {
			return body.error;
		}
		return fallback;
	}

	function applied(id: string): boolean {
		return labels.some((label) => label.id === id);
	}

	async function loadLabels() {
		try {
			const res = await fetch('/api/labels');
			const body = (await res.json().catch(() => null)) as { labels?: ApiLabel[]; error?: string } | null;
			if (!res.ok) {
				showToast(errorText(body, 'Could not load labels.'), { kind: 'error' });
				return;
			}
			catalog = Array.isArray(body?.labels) ? body.labels : [];
			labelsLoaded = true;
		} catch {
			showToast('Could not load labels.', { kind: 'error' });
		}
	}

	function toggle() {
		open = !open;
		if (open && !labelsLoaded) void loadLabels();
	}

	async function post(
		action: string,
		extra: Record<string, unknown>,
		success: string,
		undo?: { action: string; extra?: Record<string, unknown>; ids?: string[] }
	): Promise<boolean> {
		if (busy || ids.length === 0) return false;
		busy = true;
		const acted = [...ids];
		const undoIds = [...(undo?.ids ?? acted)];
		try {
			const res = await fetch('/api/mail/actions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action, ids: acted, ...extra })
			});
			const body = await res.json().catch(() => null);
			if (!res.ok) {
				showToast(errorText(body, "That didn't go through. Check your connection and try again."), {
					kind: 'error'
				});
				return false;
			}

			showToast(
				success,
				undo && undoIds.length > 0
					? {
							actionLabel: 'Undo',
							onAction: async () => {
								try {
									const undoRes = await fetch('/api/mail/actions', {
										method: 'POST',
										headers: { 'Content-Type': 'application/json' },
										body: JSON.stringify({
											action: undo.action,
											ids: undoIds,
											...undo.extra
										})
									});
									if (!undoRes.ok) {
										const undoBody = await undoRes.json().catch(() => null);
										showToast(errorText(undoBody, "Couldn't undo."), { kind: 'error' });
										return;
									}
									await invalidateAll();
									await onChanged?.();
								} catch {
									showToast("Couldn't undo.", { kind: 'error' });
								}
							}
						}
					: undefined
			);
			open = false;
			await invalidateAll();
			await onChanged?.();
			return true;
		} catch {
			showToast("That didn't go through. Check your connection and try again.", { kind: 'error' });
			return false;
		} finally {
			busy = false;
		}
	}

	function snoozePreset(preset: SnoozePreset) {
		const until = snoozeInstant(preset, new Date());
		void post('snooze', { until }, 'Snoozed', { action: 'snooze', extra: { until: null } });
	}

	function snoozeCustom() {
		const parsed = new Date(customWhen);
		if (!customWhen || Number.isNaN(parsed.getTime())) {
			showToast('Pick a date and time.', { kind: 'error' });
			return;
		}
		const until = parsed.toISOString();
		if (!isFutureInstant(until, new Date())) {
			showToast('Snooze time must be in the future', { kind: 'error' });
			return;
		}
		void post('snooze', { until }, 'Snoozed', { action: 'snooze', extra: { until: null } });
	}

	function toggleLabel(id: string, on: boolean) {
		void post(on ? 'label' : 'unlabel', { labelId: id }, on ? 'Label added' : 'Label removed');
	}

	async function createLabel(event: SubmitEvent) {
		event.preventDefault();
		const name = newName.trim();
		if (!name || busy) return;
		busy = true;
		let createdId = '';
		try {
			const res = await fetch('/api/labels', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, parentId: null, color: 'blue' })
			});
			const body = (await res.json().catch(() => null)) as {
				error?: string;
				label?: { id?: string };
			} | null;
			if (!res.ok) {
				showToast(errorText(body, 'Could not create that label.'), { kind: 'error' });
				return;
			}
			newName = '';
			createdId = typeof body?.label?.id === 'string' ? body.label.id : '';
			labelsLoaded = false;
			await loadLabels();
		} catch {
			showToast('Could not create that label.', { kind: 'error' });
			return;
		} finally {
			busy = false;
		}
		if (createdId) {
			await post('label', { labelId: createdId }, 'Label added');
		}
	}
</script>

<div class="organize">
	{#if showChips && labels.length > 0}
		<div class="chips">
			{#each labels as label (label.id)}
				<a class="chip" href="/labels/{label.id}" data-color={label.color}>
					{label.name}
					<button
						type="button"
						class="chip-remove"
						aria-label="Remove {label.name}"
						disabled={busy}
						onclick={(event) => {
							event.preventDefault();
							event.stopPropagation();
							void post('unlabel', { labelId: label.id }, 'Label removed');
						}}
					>
						<Icon name="close-line" size={12} />
					</button>
				</a>
			{/each}
		</div>
	{/if}

	{#if showMenu}
		<button
			type="button"
			class="icon-btn"
			aria-label="Organize"
			title="Organize"
			aria-expanded={open}
			disabled={busy || ids.length === 0}
			onclick={toggle}
		>
			<Icon name="price-tag-3-line" size={16} />
			{#if labeled}<span class="btn-text skin-only">Organize</span>{/if}
		</button>

		{#if open}
			<button type="button" class="backdrop" aria-label="Close menu" onclick={() => (open = false)}
			></button>
			<div class="menu" class:right={align === 'right'} role="menu">
				{#if showArchive}
					<button
						type="button"
						class="menu-item"
						disabled={busy}
						onclick={() =>
							post('archive', {}, 'Archived', {
								action: 'inbox',
								ids: inboxUndoTargets(ids, 'archive', { inboxIds, inInbox, inboxMixed })
							})}
					>
						<Icon name="archive-line" size={15} /> Archive
					</button>
				{/if}
				{#if showMoveToInbox}
					<button
						type="button"
						class="menu-item"
						disabled={busy}
						onclick={() =>
							post('inbox', {}, 'Moved to inbox', {
								action: 'archive',
								ids: inboxUndoTargets(ids, 'inbox', { inboxIds, inInbox, inboxMixed })
							})}
					>
						<Icon name="inbox-line" size={15} /> Move to inbox
					</button>
				{/if}

				<p class="group">Snooze</p>
				{#each SNOOZE_PRESETS as preset (preset.id)}
					<button
						type="button"
						class="menu-item"
						disabled={busy}
						onclick={() => snoozePreset(preset.id)}
					>
						<Icon name="time-line" size={15} /> {preset.label}
					</button>
				{/each}
				<div class="custom-snooze">
					<input type="datetime-local" bind:value={customWhen} aria-label="Snooze date and time" />
					<button type="button" class="menu-item" disabled={busy} onclick={snoozeCustom}>
						Snooze
					</button>
				</div>

				{#if showMute}
					<button type="button" class="menu-item" disabled={busy} onclick={() => post('mute', {}, 'Muted')}>
						<Icon name="volume-mute-line" size={15} /> Mute
					</button>
				{/if}
				{#if showUnmute}
					<button
						type="button"
						class="menu-item"
						disabled={busy}
						onclick={() => post('unmute', {}, 'Unmuted')}
					>
						<Icon name="volume-up-line" size={15} /> Unmute
					</button>
				{/if}
				{#if showImportant}
					<button
						type="button"
						class="menu-item"
						disabled={busy}
						onclick={() => post('important', {}, 'Marked important')}
					>
						<Icon name="flag-line" size={15} /> Important
					</button>
				{/if}
				{#if showNotImportant}
					<button
						type="button"
						class="menu-item"
						disabled={busy}
						onclick={() => post('unimportant', {}, 'Not important')}
					>
						<Icon name="flag-line" size={15} /> Not important
					</button>
				{/if}

				<p class="group">Category</p>
				{#each CATEGORIES as item (item)}
					<button
						type="button"
						class="menu-item"
						disabled={busy}
						onclick={() => post('category', { category: item }, `Moved to ${CATEGORY_LABELS[item]}`)}
					>
						<Icon
							name={currentCategory === item ? 'checkbox-line' : 'checkbox-blank-line'}
							size={15}
						/>
						{CATEGORY_LABELS[item]}
					</button>
				{/each}

				<p class="group">Labels</p>
				{#if !labelsLoaded}
					<p class="hint">Loading labels…</p>
				{:else if labelRows.length === 0}
					<p class="hint">No labels yet</p>
				{:else}
					{#each labelRows as row (row.label.id)}
						<label class="check" style="padding-left: {0.75 + row.depth * 0.75}rem">
							<input
								type="checkbox"
								checked={applied(row.label.id)}
								disabled={busy}
								onchange={(event) => {
									const next = event.currentTarget.checked;
									event.currentTarget.checked = applied(row.label.id);
									toggleLabel(row.label.id, next);
								}}
							/>
							<span class="dot" data-color={row.label.color}></span>
							{row.label.name}
						</label>
					{/each}
				{/if}
				<form class="create" onsubmit={createLabel}>
					<input bind:value={newName} placeholder="New label" aria-label="New label" />
					<button type="submit" disabled={busy || newName.trim().length === 0}>Create</button>
				</form>

				<button
					type="button"
					class="menu-item danger"
					disabled={busy}
					onclick={() => post('block', {}, 'Sender blocked')}
				>
					<Icon name="forbid-line" size={15} /> Block sender
				</button>
			</div>
		{/if}
	{/if}
</div>

<style>
	.organize {
		position: relative;
		display: flex;
		align-items: center;
		gap: 0.375rem;
		min-width: 0;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		min-width: 0;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.125rem;
		max-width: 9rem;
		height: 1.25rem;
		padding: 0 0.125rem 0 0.375rem;
		border-radius: 9999px;
		font-size: 0.6875rem;
		color: var(--color-text);
		background: var(--color-surface-muted);
		box-shadow: inset 0 0 0 1px var(--color-line);
		text-decoration: none;
		position: relative;
		z-index: 2;
	}

	.chip::before {
		content: '';
		width: 0.375rem;
		height: 0.375rem;
		border-radius: 9999px;
		background: var(--chip, var(--color-muted));
		flex-shrink: 0;
	}

	.chip[data-color='slate'] { --chip: #5f6368; }
	.chip[data-color='red'] { --chip: #d93025; }
	.chip[data-color='orange'] { --chip: #e37400; }
	.chip[data-color='amber'] { --chip: #f9ab00; }
	.chip[data-color='green'] { --chip: #188038; }
	.chip[data-color='blue'] { --chip: #1a73e8; }
	.chip[data-color='violet'] { --chip: #9334e6; }
	.chip[data-color='pink'] { --chip: #d01884; }

	.chip-remove {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1rem;
		height: 1rem;
		border-radius: 9999px;
		color: var(--color-text-secondary);
	}

	.chip-remove:hover {
		background: var(--color-surface-hover);
		color: var(--color-text);
	}

	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 20;
	}

	.menu {
		position: absolute;
		top: calc(100% + 0.5rem);
		left: 0;
		z-index: 30;
		width: 16rem;
		max-height: min(24rem, 70vh);
		overflow: auto;
		padding: 0.5rem;
		background: var(--color-surface);
		border-radius: 0.5rem;
		box-shadow: var(--shadow-md);
		border: 1px solid var(--color-line);
	}

	.menu.right {
		left: auto;
		right: 0;
	}

	.group {
		margin: 0.375rem 0 0.125rem;
		padding: 0.375rem 0.75rem 0.125rem;
		font-size: 0.6875rem;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--color-muted);
	}

	.menu-item {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
		padding: 0.5rem 0.75rem;
		border-radius: 0.25rem;
		font-size: 0.875rem;
		color: var(--color-text);
		text-align: left;
	}

	.menu-item:hover:not(:disabled) {
		background: var(--color-surface-hover);
	}

	.menu-item:disabled {
		opacity: 0.5;
	}

	.menu-item.danger:hover:not(:disabled) {
		color: var(--color-danger);
	}

	.custom-snooze {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.25rem 0.75rem 0.5rem;
	}

	.custom-snooze input,
	.create input {
		width: 100%;
		height: 2rem;
		padding: 0 0.5rem;
		border-radius: 0.25rem;
		border: 1px solid var(--color-line);
		background: var(--color-surface);
		color: var(--color-text);
		font-size: 0.8125rem;
	}

	.check {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding-top: 0.375rem;
		padding-bottom: 0.375rem;
		padding-right: 0.75rem;
		font-size: 0.875rem;
		color: var(--color-text);
	}

	.dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 9999px;
		background: var(--color-muted);
		flex-shrink: 0;
	}

	.dot[data-color='slate'] { background: #5f6368; }
	.dot[data-color='red'] { background: #d93025; }
	.dot[data-color='orange'] { background: #e37400; }
	.dot[data-color='amber'] { background: #f9ab00; }
	.dot[data-color='green'] { background: #188038; }
	.dot[data-color='blue'] { background: #1a73e8; }
	.dot[data-color='violet'] { background: #9334e6; }
	.dot[data-color='pink'] { background: #d01884; }

	.hint {
		padding: 0.375rem 0.75rem;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.create {
		display: flex;
		gap: 0.375rem;
		padding: 0.375rem 0.75rem 0.5rem;
	}

	.create button {
		flex-shrink: 0;
		height: 2rem;
		padding: 0 0.625rem;
		border-radius: 0.25rem;
		font-size: 0.8125rem;
		color: var(--color-text);
		background: var(--color-surface-hover);
	}

	.create button:disabled {
		opacity: 0.5;
	}
</style>
