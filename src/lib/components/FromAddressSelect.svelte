<script lang="ts">
	import type { ReplyFromOption } from '$lib/reply-from';

	let {
		options,
		value,
		onchange
	}: {
		options: ReplyFromOption[];
		value: string;
		onchange: (key: string) => void;
	} = $props();
</script>

{#if options.length > 0}
	<div class="reply-from">
		<label class="reply-from-label" for="reply-from">From</label>
		<select
			id="reply-from"
			{value}
			onchange={(event) => onchange(event.currentTarget.value)}
			class="reply-from-select"
			aria-label="Send from"
		>
			{#each options as option (option.key)}
				<option value={option.key}>{option.address}</option>
			{/each}
		</select>
	</div>
{/if}

<style>
	.reply-from {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 0.75rem;
	}

	.reply-from-label {
		flex-shrink: 0;
		font-size: 0.875rem;
		color: var(--color-text-secondary);
	}

	.reply-from-select {
		flex: 1;
		min-width: 0;
		padding: 0.25rem 0;
		font-size: 0.875rem;
		color: var(--color-text);
		background: transparent;
		border: none;
		outline: none;
		cursor: pointer;
	}

	.reply-from-select:focus {
		color: var(--color-text);
	}
</style>
