<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let busy = $state(false);

	const subscribed = $derived(
		form && 'done' in form ? form.done === 'resubscribed' : (data.subscription?.subscribed ?? false)
	);
</script>

<svelte:head>
	<title>{data.subscription ? `Email from ${data.subscription.domain}` : 'Unsubscribe'}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main class="wrap">
	<article class="card">
		{#if !data.subscription}
			<h1>This link isn't valid</h1>
			<p class="muted">It may have been copied incompletely. Use the Unsubscribe link in the newest email you got.</p>
		{:else}
			{@const sub = data.subscription}
			<p class="eyebrow">{sub.domain}</p>
			{#if form && 'done' in form}
				<p class="status" role="status">
					{form.done === 'unsubscribed' ? "You're unsubscribed." : "You're subscribed again."}
				</p>
			{/if}
			{#if form && 'error' in form}<p class="error" role="alert">{form.error}</p>{/if}

			{#if subscribed}
				<h1>Unsubscribe from {sub.domain}?</h1>
				<p class="muted">{sub.address} will stop getting marketing email from {sub.domain}. Replies to your own messages still reach you.</p>
				<form method="POST" action="?/unsubscribe" use:enhance={() => { busy = true; return async ({ update }) => { await update({ reset: false }); busy = false; }; }}>
					<button type="submit" class="primary" disabled={busy}>Unsubscribe</button>
				</form>
			{:else}
				<h1>You won't get marketing email from {sub.domain}</h1>
				<p class="muted">{sub.address} is unsubscribed. Changed your mind? You can subscribe again.</p>
				<form method="POST" action="?/resubscribe" use:enhance={() => { busy = true; return async ({ update }) => { await update({ reset: false }); busy = false; }; }}>
					<button type="submit" class="secondary" disabled={busy}>Subscribe again</button>
				</form>
			{/if}
		{/if}
	</article>
</main>

<style>
	:global(body) {
		background: var(--color-surface-muted);
	}

	.wrap {
		display: flex;
		justify-content: center;
		min-height: 100dvh;
		padding: 2.5rem 1rem;
		color: var(--color-text);
	}

	.card {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.875rem;
		align-self: flex-start;
		width: min(100%, 30rem);
		padding: 2rem;
		border-radius: 0.875rem;
		background: var(--color-surface);
		box-shadow:
			0 1px 2px rgb(0 0 0 / 0.04),
			0 8px 28px rgb(0 0 0 / 0.07),
			inset 0 0 0 1px var(--color-line);
	}

	.eyebrow {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--color-text-secondary);
	}

	h1 {
		font-size: 1.375rem;
		font-weight: 700;
		line-height: 1.3;
		text-wrap: balance;
	}

	.muted {
		color: var(--color-text-secondary);
		line-height: 1.55;
	}

	.status {
		padding: 0.625rem 0.875rem;
		border-radius: 0.5rem;
		font-weight: 600;
		color: #2f7a4d;
		background: color-mix(in srgb, #2f9e5b 12%, transparent);
	}

	.error {
		color: var(--color-danger, #c0392b);
	}

	form {
		margin-top: 0.25rem;
	}

	.primary,
	.secondary {
		padding: 0.6875rem 1.25rem;
		border-radius: 9999px;
		font-weight: 600;
	}

	.primary {
		color: var(--color-on-accent);
		background: var(--color-link);
	}

	.secondary {
		color: var(--color-text);
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	button:disabled {
		opacity: 0.6;
	}
</style>
