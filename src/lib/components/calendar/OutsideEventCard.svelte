<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import { CALENDAR_HEX, type CalendarInfo, type Occurrence } from '#lib/calendar/types.ts';

	/** An event from an outside calendar: shown, not edited (it lives in Google, iCloud or Outlook). */
	let { occurrence, calendar, onClose }: { occurrence: Occurrence; calendar: CalendarInfo; onClose: () => void } = $props();

	const when = $derived.by(() => {
		const start = new Date(occurrence.start);
		const end = new Date(occurrence.end);
		if (occurrence.allDay) {
			const last = new Date(end.getTime() - 86_400_000);
			const day = (date: Date) => date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
			return last.toDateString() === start.toDateString() ? `${day(start)}, all day` : `${day(start)} – ${day(last)}`;
		}
		const date = start.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
		const time = (value: Date) => value.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
		return `${date}, ${time(start)} – ${time(end)}`;
	});

	function onKey(event: KeyboardEvent) {
		if (event.key === 'Escape') onClose();
	}
</script>

<svelte:window onkeydown={onKey} />

<div class="scrim" role="presentation" onclick={onClose}></div>
<div class="dialog surface-lg" role="dialog" aria-modal="true" aria-labelledby="outside-event-title">
	<header class="dialog-head">
		<h2 id="outside-event-title">{occurrence.title}</h2>
		<button type="button" class="icon-button" aria-label="Close" onclick={onClose}>
			<Icon name="close-line" size={18} />
		</button>
	</header>
	<p class="row"><Icon name="time-line" size={15} /> {when}</p>
	{#if occurrence.location}<p class="row"><Icon name="map-pin-line" size={15} /> {occurrence.location}</p>{/if}
	{#if occurrence.description}<p class="notes">{occurrence.description}</p>{/if}
	<p class="source">
		<span class="dot" style="background: {CALENDAR_HEX[calendar.color]}"></span>
		From {calendar.name}{calendar.source?.host ? ` (${calendar.source.host})` : ''}. To change it, edit it there; CloudMail
		keeps a read-only copy.
	</p>
</div>

<style>
	.scrim {
		position: fixed;
		inset: 0;
		z-index: 60;
		background: var(--color-scrim);
	}

	.dialog {
		position: fixed;
		z-index: 61;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		width: min(28rem, calc(100vw - 2rem));
		max-height: calc(100dvh - 2rem);
		overflow-y: auto;
		padding: 1.25rem;
		border-radius: 0.875rem;
		background: var(--color-surface);
	}

	.dialog-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.dialog-head h2 {
		font-size: 1.0625rem;
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	.icon-button {
		display: inline-flex;
		padding: 0.25rem;
		border-radius: 0.375rem;
		color: var(--color-muted);
	}

	.icon-button:hover {
		color: var(--color-text);
		background: var(--color-surface-muted);
	}

	.row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.875rem;
	}

	.notes {
		font-size: 0.875rem;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		color: var(--color-text-secondary);
	}

	.source {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		padding-top: 0.625rem;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		box-shadow: inset 0 1px 0 var(--color-line);
	}

	.dot {
		flex-shrink: 0;
		width: 0.625rem;
		height: 0.625rem;
		border-radius: 9999px;
	}
</style>
