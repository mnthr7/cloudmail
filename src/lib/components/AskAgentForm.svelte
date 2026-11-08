<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import { showToast } from '#lib/toast.ts';

	/**
	 * Hands a thread to an agent with a request. The agent runs within a minute
	 * and only proposes; what it proposes shows on the Staff page.
	 */
	let {
		agents,
		emailId,
		onClose
	}: {
		agents: Array<{ id: string; name: string }>;
		/** The newest message in the thread. */
		emailId: string;
		onClose: () => void;
	} = $props();

	let agentId = $state('');
	let text = $state('');
	let asking = $state(false);
	let error = $state('');
	const chosen = $derived(agentId || agents[0]?.id || '');

	const ERRORS: Record<string, string> = {
		request: 'Say what you need, up to 2,000 characters.',
		paused: 'That agent is paused. Resume it on the Staff page first.',
		email: 'This message is no longer in your mailbox.'
	};

	async function ask(event: SubmitEvent) {
		event.preventDefault();
		if (!chosen || !text.trim()) return;
		asking = true;
		error = '';
		try {
			const res = await fetch(`/api/agents/${chosen}/ask`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ emailId, request: text })
			});
			const body = await res.json().catch(() => null);
			if (!res.ok) {
				error =
					res.status === 403
						? 'Only its owner or an admin can give it work.'
						: (ERRORS[body?.error] ?? 'Could not ask the agent.');
				return;
			}
			const name = agents.find((agent) => agent.id === chosen)?.name ?? 'The agent';
			showToast(`${name} will look at this within a minute. What it proposes shows up on the Staff page.`);
			text = '';
			onClose();
		} catch {
			error = 'Network error';
		} finally {
			asking = false;
		}
	}
</script>

<form class="ask-section" onsubmit={ask}>
	<div class="ask-head">
		<label class="ask-agent">
			<span>Ask</span>
			<select class="ask-input" value={chosen} onchange={(event) => (agentId = event.currentTarget.value)}>
				{#each agents as agent (agent.id)}
					<option value={agent.id}>{agent.name}</option>
				{/each}
			</select>
		</label>
		<span class="ask-hint">It reads this thread and proposes what to do. Nothing is sent without your OK.</span>
	</div>
	<textarea
		class="ask-input"
		rows="3"
		maxlength="2000"
		bind:value={text}
		placeholder="Draft a reply that offers two times next week"
		aria-label="What you need"
	></textarea>
	{#if error}
		<p class="ask-error">{error}</p>
	{/if}
	<div class="ask-actions">
		<button type="button" class="btn-ghost" onclick={onClose}>Cancel</button>
		<button type="submit" class="btn-primary" disabled={asking || !text.trim()}>
			<Icon name="robot-2-line" size={16} />
			{asking ? 'Asking…' : 'Ask'}
		</button>
	</div>
</form>

<style>
	.ask-section {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		margin-top: 1.5rem;
		padding-top: 1.25rem;
		box-shadow: inset 0 1px 0 var(--color-line);
	}

	.ask-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 0.75rem;
	}

	.ask-agent {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.875rem;
		font-weight: 600;
	}

	.ask-hint {
		font-size: 0.8rem;
		color: var(--color-text-secondary);
	}

	.ask-input {
		padding: 0.5rem 0.75rem;
		border-radius: 0.5rem;
		font: inherit;
		font-size: 0.875rem;
		font-weight: 400;
		color: var(--color-text);
		background: var(--color-surface-muted);
		box-shadow: inset 0 0 0 1px var(--color-line);
		border: none;
		outline: none;
	}

	textarea.ask-input {
		width: 100%;
		resize: vertical;
	}

	.ask-input:focus {
		box-shadow: inset 0 0 0 1px var(--color-focus-line), 0 0 0 3px var(--color-focus-halo);
	}

	.ask-error {
		font-size: 0.875rem;
		color: var(--color-danger);
	}

	.ask-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
</style>
