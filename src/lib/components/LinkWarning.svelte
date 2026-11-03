<script lang="ts">
	let {
		sentence,
		href,
		onOpen,
		onCancel
	}: {
		sentence: string;
		href: string;
		onOpen: () => void;
		onCancel: () => void;
	} = $props();

	function open() {
		window.open(href, '_blank', 'noopener');
		onOpen();
	}
</script>

<div class="backdrop">
	<div
		class="dialog"
		role="dialog"
		aria-modal="true"
		aria-labelledby="link-warning-sentence"
	>
		<p id="link-warning-sentence" class="sentence">{sentence}</p>
		<p class="href">{href}</p>
		<div class="actions">
			<button type="button" class="btn-ghost" onclick={onCancel}>Cancel</button>
			<button type="button" class="btn-primary" onclick={open}>Open</button>
		</div>
	</div>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 300;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1.5rem;
		background: var(--color-scrim);
	}

	.dialog {
		width: min(28rem, 100%);
		padding: 1.25rem 1.25rem 1rem;
		border-radius: 0.75rem;
		background: var(--color-surface);
		color: var(--color-text);
		box-shadow: var(--shadow-md);
	}

	.sentence {
		font-size: 0.9375rem;
		line-height: 1.5;
	}

	.href {
		margin-top: 0.75rem;
		font-size: 0.8125rem;
		line-height: 1.45;
		color: var(--color-text-secondary);
		overflow-wrap: anywhere;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 1.25rem;
	}
</style>
