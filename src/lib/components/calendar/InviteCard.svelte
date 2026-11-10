<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import type { InviteView } from '#lib/calendar/types.ts';

	/** A calendar invite, update, cancellation or RSVP in an email, with Yes / Maybe / No for invites. */
	let { invite }: { invite: InviteView } = $props();

	let response = $state<string | null>(null);
	let onCalendar = $state<boolean | null>(null);
	let busy = $state(false);
	let note = $state('');

	const current = $derived(response ?? invite.response);
	const added = $derived(onCalendar ?? invite.onCalendar);
	const organizer = $derived(
		invite.organizer && !invite.organizer.email.endsWith('@invalid')
			? invite.organizer.name || invite.organizer.email
			: null
	);

	const CHOICES = [
		{ value: 'ACCEPTED', label: 'Yes' },
		{ value: 'TENTATIVE', label: 'Maybe' },
		{ value: 'DECLINED', label: 'No' }
	] as const;

	const REPLIES: Record<string, string> = {
		ACCEPTED: 'accepted',
		TENTATIVE: 'said maybe to',
		DECLINED: 'declined',
		'NEEDS-ACTION': "hasn't answered"
	};

	async function answer(value: string) {
		if (busy) return;
		busy = true;
		note = '';
		try {
			const res = await fetch(`/api/calendar/invites/${invite.id}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ response: value })
			});
			const body = await res.json().catch(() => null);
			if (!res.ok) {
				note = "Couldn't save your answer. Try again.";
				return;
			}
			response = value;
			onCalendar = value !== 'DECLINED';
			note =
				value === 'DECLINED'
					? body?.replied
						? 'Declined. The organizer was told.'
						: 'Declined.'
					: body?.replied
						? 'On your calendar. The organizer was told.'
						: 'On your calendar.';
		} catch {
			note = 'Network error';
		} finally {
			busy = false;
		}
	}
</script>

<section class="invite" class:cancelled={invite.method === 'CANCEL'} aria-label="Calendar invite">
	<div class="icon"><Icon name={invite.method === 'CANCEL' ? 'calendar-close-line' : 'calendar-event-line'} size={20} /></div>
	<div class="details">
		{#if invite.method === 'REPLY' && invite.reply}
			<p class="title">
				{invite.reply.name || invite.reply.email}
				{REPLIES[invite.reply.partstat] ?? 'answered'}
				"{invite.title}"
			</p>
			<p class="meta">{invite.when}</p>
		{:else}
			<p class="title">
				{#if invite.method === 'CANCEL'}<span class="tag">Canceled</span>{/if}
				{invite.title}
			</p>
			<p class="meta">{invite.when}</p>
			{#if invite.location}<p class="meta"><Icon name="map-pin-line" size={13} /> {invite.location}</p>{/if}
			{#if organizer}<p class="meta">Organized by {organizer}</p>{/if}

			{#if invite.method === 'REQUEST' || invite.method === 'PUBLISH'}
				<div class="choices" role="group" aria-label="Going?">
					<span class="ask">Going?</span>
					{#each CHOICES as choice (choice.value)}
						<button
							type="button"
							class="choice"
							class:chosen={current === choice.value}
							aria-pressed={current === choice.value}
							disabled={busy}
							onclick={() => answer(choice.value)}
						>
							{choice.label}
						</button>
					{/each}
					{#if added}<a class="open" href="/calendar">Open calendar</a>{/if}
				</div>
			{/if}
			{#if note}<p class="meta" role="status">{note}</p>{/if}
		{/if}
	</div>
</section>

<style>
	.invite {
		display: flex;
		gap: 0.75rem;
		margin: 0 0 1rem;
		padding: 0.875rem 1rem;
		border-radius: 0.75rem;
		background: var(--color-surface-muted);
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.icon {
		color: var(--color-accent);
	}

	.cancelled .icon {
		color: var(--color-text-secondary);
	}

	.details {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
	}

	.title {
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	.cancelled .title {
		text-decoration: line-through;
		text-decoration-thickness: 1px;
	}

	.tag {
		display: inline-block;
		margin-right: 0.375rem;
		padding: 0 0.375rem;
		border-radius: 9999px;
		font-size: 0.75rem;
		font-weight: 500;
		text-decoration: none;
		color: var(--color-text-secondary);
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.meta {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.choices {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.375rem;
		margin-top: 0.375rem;
	}

	.ask {
		font-size: 0.8125rem;
		margin-right: 0.25rem;
	}

	.choice {
		padding: 0.25rem 0.875rem;
		border-radius: 9999px;
		font-size: 0.8125rem;
		box-shadow: inset 0 0 0 1px var(--color-line);
		background: var(--color-surface);
	}

	.choice.chosen {
		color: var(--color-on-accent);
		background: var(--color-accent);
		box-shadow: none;
	}

	.open {
		margin-left: 0.25rem;
		font-size: 0.8125rem;
		color: var(--color-link);
	}
</style>
