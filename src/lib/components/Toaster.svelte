<script lang="ts">
	import { toasts } from '#lib/toast.ts';

	async function act(id: number, run?: () => void | Promise<void>) {
		toasts.update((list) => list.filter((entry) => entry.id !== id));
		await run?.();
	}
</script>

<div class="toaster" role="status" aria-live="polite">
	{#each $toasts as toast (toast.id)}
		<div class="toast" class:error={toast.kind === 'error'}>
			<span>{toast.message}</span>
			{#if toast.actionLabel}
				<button type="button" onclick={() => act(toast.id, toast.onAction)}>
					{toast.actionLabel}
				</button>
			{/if}
		</div>
	{/each}
</div>

<style>
	.toaster {
		position: fixed;
		left: 0;
		right: 0;
		bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
		z-index: 400;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		pointer-events: none;
		padding: 0 1rem;
	}

	.toast {
		pointer-events: auto;
		display: flex;
		align-items: center;
		gap: 1rem;
		max-width: 28rem;
		padding: 0.7rem 1rem;
		border-radius: 0.6rem;
		background: #1f1f23;
		color: #fff;
		font-size: 0.9rem;
		box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25);
	}

	.toast.error {
		background: #9b1c1c;
	}

	.toast button {
		min-height: 2.25rem;
		padding: 0 0.75rem;
		border: 0;
		border-radius: 0.4rem;
		background: transparent;
		color: #9ec2ff;
		font-weight: 650;
		font-size: 0.9rem;
		cursor: pointer;
		touch-action: manipulation;
	}
</style>
