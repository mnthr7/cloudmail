<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import { explainDetail, type ActivityState, type ThreadActivity } from '#lib/agents/activity.ts';

	/**
	 * What agents did, want to do, or noted on this thread (A12), and the
	 * take-over switch (A13). Only the mailbox owner sees any of it.
	 */
	let {
		activity,
		emailId,
		hasAgents = false
	}: {
		activity: ThreadActivity | null;
		/** Any message in the thread, for the take-over route. */
		emailId: string | null;
		/** Agents exist in the workspace, so taking over means something. */
		hasAgents?: boolean;
	} = $props();

	let override = $state<ThreadActivity | null>(null);
	let busy = $state(false);
	let error = $state('');
	let expanded = $state(false);

	const current = $derived(override ?? activity);
	const items = $derived(current?.items ?? []);
	const takenOver = $derived(current?.takenOver ?? false);
	// Newest few unless opened: notes and alerts matter most, so they're always shown.
	const VISIBLE = 4;
	const shown = $derived(expanded ? items : items.slice(-VISIBLE));

	$effect(() => {
		// A different thread was loaded.
		void activity;
		override = null;
		expanded = false;
	});

	async function toggleTakeOver() {
		if (!emailId || busy) return;
		busy = true;
		error = '';
		try {
			const res = await fetch(`/api/mail/${emailId}/take-over`, { method: takenOver ? 'DELETE' : 'POST' });
			const body = await res.json().catch(() => null);
			if (!res.ok || !body?.activity) {
				error = 'Could not change that. Try again.';
				return;
			}
			override = body.activity;
		} catch {
			error = 'Network error';
		} finally {
			busy = false;
		}
	}

	const STATE_TEXT: Record<ActivityState, string> = {
		waiting: 'Waiting for your OK',
		done: 'Done',
		shadow: 'Would have done (shadow mode)',
		declined: 'Declined',
		expired: 'Expired',
		refused: 'Refused',
		failed: "Couldn't be done",
		stopped: 'Stopped'
	};

	const STATE_ICON: Record<ActivityState, string> = {
		waiting: 'time-line',
		done: 'checkbox-circle-line',
		shadow: 'eye-line',
		declined: 'close-circle-line',
		expired: 'time-line',
		refused: 'forbid-line',
		failed: 'error-warning-line',
		stopped: 'error-warning-line'
	};

	function when(at: string): string {
		const date = new Date(at);
		return Number.isNaN(date.getTime())
			? ''
			: date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
	}
</script>

{#if items.length > 0 || (hasAgents && emailId)}
	<section class="activity" aria-label="Agent activity">
		<header class="activity-head">
			<Icon name="robot-2-line" size={16} />
			<span class="title">Agents</span>
			{#if takenOver}
				<span class="pill">You've taken over</span>
			{/if}
			{#if emailId && (hasAgents || takenOver)}
				<button type="button" class="btn-ghost take-over" disabled={busy} onclick={toggleTakeOver}>
					{takenOver ? 'Let agents work on this' : 'Take over'}
				</button>
			{/if}
		</header>
		{#if takenOver}
			<p class="hint">Agents won't act on this thread on their own. You can still ask one for help.</p>
		{/if}
		{#if error}
			<p class="error" role="alert">{error}</p>
		{/if}

		{#if items.length > VISIBLE && !expanded}
			<button type="button" class="more" onclick={() => (expanded = true)}>
				Show all {items.length}
			</button>
		{/if}

		<ol class="items">
			{#each shown as item, index (item.kind === 'takeover' ? `takeover-${index}` : item.id)}
				{#if item.kind === 'action'}
					<li class="item state-{item.state}">
						<Icon name={STATE_ICON[item.state]} size={15} />
						<div class="body">
							<p class="line">
								<strong>{item.agentName}</strong>
								<span>{item.what}</span>
								<span class="state">· {STATE_TEXT[item.state]}</span>
								{#if item.decidedBy && (item.state === 'done' || item.state === 'declined' || item.state === 'failed' || item.state === 'stopped')}
									<span class="by">· {item.state === 'declined' ? 'declined' : 'approved'} by {item.decidedBy}</span>
								{:else if item.trigger === 'ask'}
									<span class="by">· you asked</span>
								{:else if item.trigger === 'mail' && item.state === 'done'}
									<span class="by">· on its own</span>
								{/if}
							</p>
							{#if explainDetail(item.state, item.detail)}
								<p class="detail">Because {explainDetail(item.state, item.detail)}.</p>
							{/if}
							{#if item.reason}
								<p class="reason">{item.reason}</p>
							{/if}
						</div>
						<time datetime={item.at}>{when(item.at)}</time>
					</li>
				{:else if item.kind === 'note' || item.kind === 'alert'}
					<li class="item note" class:alert={item.kind === 'alert'}>
						<Icon name={item.kind === 'alert' ? 'error-warning-line' : 'sticky-note-line'} size={15} />
						<div class="body">
							<p class="line"><strong>{item.agentName ?? 'Agent'}</strong> <span>{item.kind === 'alert' ? 'stopped itself' : 'left a note'}</span></p>
							<p class="note-text">{item.body}</p>
						</div>
						<time datetime={item.at}>{when(item.at)}</time>
					</li>
				{:else if item.kind === 'takeover'}
					<li class="item">
						<Icon name="user-shared-line" size={15} />
						<div class="body">
							<p class="line"><strong>{item.by ?? 'You'}</strong> <span>took this thread over</span></p>
						</div>
						<time datetime={item.at}>{when(item.at)}</time>
					</li>
				{/if}
			{/each}
		</ol>
	</section>
{/if}

<style>
	.activity {
		margin-top: 1.5rem;
		padding-top: 1.25rem;
		box-shadow: inset 0 1px 0 var(--color-line);
		font-size: 0.8125rem;
	}

	.activity-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.875rem;
	}

	.title {
		font-weight: 600;
	}

	.pill {
		padding: 0.125rem 0.5rem;
		border-radius: 9999px;
		font-size: 0.75rem;
		background: var(--color-surface-muted);
		color: var(--color-text-secondary);
	}

	.take-over {
		margin-left: auto;
		font-size: 0.8125rem;
	}

	.hint,
	.error {
		margin-top: 0.375rem;
		color: var(--color-text-secondary);
	}

	.error {
		color: var(--color-danger);
	}

	.more {
		margin-top: 0.5rem;
		color: var(--color-text-secondary);
		text-decoration: underline;
	}

	.items {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-top: 0.625rem;
		list-style: none;
		padding: 0;
	}

	.item {
		display: grid;
		grid-template-columns: auto 1fr auto;
		gap: 0.5rem;
		align-items: start;
		color: var(--color-text-secondary);
	}

	.item :global(i) {
		margin-top: 0.125rem;
	}

	.body {
		min-width: 0;
	}

	.line {
		color: var(--color-text);
		overflow-wrap: anywhere;
	}

	.state,
	.by {
		color: var(--color-text-secondary);
	}

	.state-done :global(i) {
		color: var(--color-text);
	}

	.state-failed :global(i),
	.state-stopped :global(i),
	.alert :global(i) {
		color: var(--color-danger);
	}

	.detail,
	.reason {
		margin-top: 0.125rem;
	}

	.note-text {
		margin-top: 0.25rem;
		padding: 0.5rem 0.75rem;
		border-radius: 0.5rem;
		background: var(--color-surface-muted);
		color: var(--color-text);
		white-space: pre-line;
	}

	.alert .note-text {
		box-shadow: inset 2px 0 0 var(--color-danger);
	}

	time {
		font-size: 0.75rem;
		white-space: nowrap;
	}
</style>
