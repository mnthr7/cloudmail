<script lang="ts">
	import type { Snippet } from 'svelte';
	import { onMount } from 'svelte';
	import Icon from './Icon.svelte';

	/**
	 * A card that folds away. Click the title to open or close it; the choice is
	 * remembered per section on this device. A link to #id opens it.
	 */
	let {
		id,
		title,
		icon,
		count = null,
		open = $bindable(true),
		/** Where open/closed is remembered, e.g. "staff". Leave out to not remember. */
		remember = '',
		class: className = '',
		children
	}: {
		id: string;
		title: string;
		icon?: string;
		/** A number or short label shown beside the title, like how many are waiting. */
		count?: number | string | null;
		open?: boolean;
		remember?: string;
		class?: string;
		children: Snippet;
	} = $props();

	const key = $derived(remember ? `cm.section.${remember}.${id}` : '');

	onMount(() => {
		if (key) {
			try {
				const saved = localStorage.getItem(key);
				if (saved === '0') open = false;
				else if (saved === '1') open = true;
			} catch {
				// Storage can be blocked; the default stands.
			}
		}
		const reveal = () => {
			if (location.hash === `#${id}`) open = true;
		};
		reveal();
		window.addEventListener('hashchange', reveal);
		return () => window.removeEventListener('hashchange', reveal);
	});

	function toggled(event: Event) {
		open = (event.currentTarget as HTMLDetailsElement).open;
		if (!key) return;
		try {
			localStorage.setItem(key, open ? '1' : '0');
		} catch {
			// Not remembered; nothing else depends on it.
		}
	}
</script>

<section {id} class="surface-lg fold {className}">
	<details {open} ontoggle={toggled}>
		<summary>
			<h2>
				{#if icon}<Icon name={icon} size={18} />{/if}
				<span>{title}</span>
				{#if count !== null && count !== '' && count !== 0}
					<span class="fold-count">{count}</span>
				{/if}
			</h2>
			<Icon name="arrow-down-s-line" size={20} class="fold-chevron" />
		</summary>
		<div class="fold-body">
			{@render children()}
		</div>
	</details>
</section>

<style>
	.fold {
		margin-top: 1rem;
		scroll-margin-top: 1rem;
	}

	summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 1.125rem 1.5rem;
		cursor: pointer;
		list-style: none;
		border-radius: inherit;
		user-select: none;
	}

	summary::-webkit-details-marker {
		display: none;
	}

	summary:hover {
		background: var(--color-surface-muted);
	}

	summary:focus-visible {
		outline: 2px solid var(--color-text);
		outline-offset: -2px;
	}

	h2 {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		min-width: 0;
		margin: 0;
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--color-text);
	}

	.fold-count {
		padding: 0.0625rem 0.5rem;
		border-radius: 999px;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--color-text);
		background: var(--color-surface-muted);
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	summary :global(.fold-chevron) {
		flex: none;
		color: var(--color-text-secondary);
		transition: transform 0.15s ease;
	}

	details[open] > summary :global(.fold-chevron) {
		transform: rotate(180deg);
	}

	.fold-body {
		padding: 0 1.5rem 1.5rem;
	}

	@media (max-width: 520px) {
		summary {
			padding: 1rem;
		}

		.fold-body {
			padding: 0 1rem 1rem;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		summary :global(.fold-chevron) {
			transition: none;
		}
	}
</style>
