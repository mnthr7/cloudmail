<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import type { SuggestionView } from '#lib/agents/suggestions.ts';

	/**
	 * Replies an agent suggested for this thread. Each can be sent as is, or
	 * opened in the reply box to edit first. Shows the one-click request when
	 * there are none yet.
	 */
	let {
		suggestion,
		agentName = null,
		waiting = false,
		busy = false,
		onUse,
		onDismiss,
		onRequest
	}: {
		suggestion: SuggestionView | null;
		/** The agent a request would go to. Null hides the request button. */
		agentName?: string | null;
		/** A request is in flight: the agent hasn't answered yet. */
		waiting?: boolean;
		/** A suggestion is being sent. */
		busy?: boolean;
		onUse: (index: number, sendNow: boolean) => void;
		onDismiss: () => void;
		onRequest?: () => void;
	} = $props();
</script>

{#if suggestion}
	<section class="suggested" aria-label="Suggested replies">
		<header class="suggested-head">
			<Icon name="sparkling-2-line" size={16} />
			<span class="who">{suggestion.agentName}</span>
			<span class="intent">{suggestion.replyNeeded ? suggestion.intent : `No reply needed: ${suggestion.intent}`}</span>
			<button type="button" class="dismiss" aria-label="Dismiss suggestions" onclick={onDismiss}>
				<Icon name="close-line" size={16} />
			</button>
		</header>

		{#if suggestion.replyNeeded && suggestion.options.length}
			<div class="options">
				{#each suggestion.options as option, index (index)}
					<article class="option">
						<h3>{option.label}</h3>
						<p class="preview">{option.body}</p>
						<div class="option-actions">
							<button type="button" class="btn-ghost" disabled={busy} onclick={() => onUse(index, false)}>
								<Icon name="edit-line" size={14} />
								Edit
							</button>
							<button type="button" class="btn-primary" disabled={busy} onclick={() => onUse(index, true)}>
								<Icon name="send-plane-2-line" size={14} />
								Send
							</button>
						</div>
					</article>
				{/each}
			</div>
		{/if}
	</section>
{:else if waiting}
	<p class="suggest-waiting">
		<Icon name="loader-4-line" size={16} class="spin" />
		Writing replies… this takes about a minute.
	</p>
{:else if agentName && onRequest}
	<button type="button" class="suggest-request" onclick={onRequest}>
		<Icon name="sparkling-2-line" size={16} />
		Suggest replies with {agentName}
	</button>
{/if}

<style>
	.suggested {
		margin-top: 1.5rem;
		padding-top: 1.25rem;
		box-shadow: inset 0 1px 0 var(--color-line);
	}

	.suggested-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.875rem;
	}

	.who {
		font-weight: 600;
	}

	.intent {
		flex: 1;
		min-width: 0;
		color: var(--color-text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.dismiss {
		display: inline-flex;
		padding: 0.25rem;
		border-radius: 0.375rem;
		color: var(--color-muted);
	}

	.dismiss:hover {
		color: var(--color-text);
		background: var(--color-surface-muted);
	}

	.options {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
		gap: 0.75rem;
		margin-top: 0.75rem;
	}

	.option {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.875rem;
		border-radius: 0.75rem;
		background: var(--color-surface-muted);
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.option h3 {
		font-size: 0.875rem;
		font-weight: 600;
	}

	.preview {
		flex: 1;
		font-size: 0.8125rem;
		line-height: 1.45;
		color: var(--color-text-secondary);
		white-space: pre-line;
		display: -webkit-box;
		-webkit-line-clamp: 5;
		line-clamp: 5;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.option-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.375rem;
	}

	.suggest-request,
	.suggest-waiting {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 1.25rem;
		padding: 0.5rem 0.875rem;
		border-radius: 9999px;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.suggest-request:hover {
		color: var(--color-text);
		background: var(--color-surface-muted);
	}

	.suggest-waiting :global(.spin) {
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.suggest-waiting :global(.spin) {
			animation: none;
		}
	}
</style>
