<script lang="ts">
	import Icon from './Icon.svelte';

	let {
		icon,
		title
	}: {
		icon: string;
		title: string;
	} = $props();
</script>

<div class="empty-state">
	<div class="empty-icon">
		<Icon name={icon} size={28} />
	</div>
	<p>{title}</p>
</div>

<style>
	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 5rem 2rem;
		text-align: center;
		color: var(--color-text-secondary);
		font-size: 0.875rem;
	}

	.empty-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 4rem;
		height: 4rem;
		margin-bottom: 1.5rem;
		border-radius: 50%;
		background: var(--color-surface-muted);
		color: var(--color-text-secondary);
	}
</style>
