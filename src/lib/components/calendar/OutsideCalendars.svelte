<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import { CALENDAR_COLORS, CALENDAR_HEX, type CalendarColor, type CalendarInfo } from '#lib/calendar/types.ts';

	/**
	 * Other calendars (Google, iCloud, Outlook) copied in by their secret iCal
	 * link, read-only. They show on your calendar and count as busy time.
	 */
	let { calendars, onChange }: { calendars: CalendarInfo[]; onChange: () => Promise<void> | void } = $props();

	const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	const outside = $derived(calendars.filter((calendar) => calendar.source));

	let url = $state('');
	let name = $state('');
	let color = $state<CalendarColor>('gray');
	let details = $state(false);
	let adding = $state(false);
	let busyId = $state<string | null>(null);
	let message = $state('');
	let help = $state(false);

	const ERRORS: Record<string, string> = {
		source: "That link can't be used. Paste the calendar's secret address in iCal format (it starts with https:// or webcal://).",
		limit: 'You can add up to 10 other calendars.',
		color: 'Pick one of the colors.',
		key: 'This server has no encryption key set, so calendar links can’t be stored safely. An admin needs to set AI_KEY_ENCRYPTION_KEY.'
	};

	async function add(event: SubmitEvent) {
		event.preventDefault();
		if (adding || !url.trim()) return;
		adding = true;
		message = '';
		try {
			const res = await fetch('/api/calendar/outside', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ url, name, color, details, timezone: browserZone })
			});
			const body = await res.json().catch(() => null);
			if (!res.ok) {
				message = ERRORS[body?.error] ?? "Couldn't add that calendar. Try again.";
				return;
			}
			url = '';
			name = '';
			message = body?.error ? `Added, but the first copy failed: ${body.error}` : 'Added. Its events are on your calendar now.';
			await onChange();
		} catch {
			message = 'Network error';
		} finally {
			adding = false;
		}
	}

	async function act(calendar: CalendarInfo, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown) {
		if (busyId) return;
		if (method === 'DELETE' && !confirm(`Stop showing ${calendar.name}? The original calendar isn't changed.`)) return;
		busyId = calendar.id;
		message = '';
		try {
			const res = await fetch(`/api/calendar/outside/${calendar.id}`, {
				method,
				headers: body ? { 'Content-Type': 'application/json' } : undefined,
				body: body ? JSON.stringify(body) : undefined
			});
			const result = await res.json().catch(() => null);
			if (!res.ok) message = ERRORS[result?.error] ?? "Couldn't do that. Try again.";
			else if (method === 'POST') message = result?.error ?? `${calendar.name} is up to date.`;
			else if (method === 'PATCH') {
				// The copy is rebuilt with or without titles on the next refresh; do it now.
				await fetch(`/api/calendar/outside/${calendar.id}`, { method: 'POST' });
			}
			await onChange();
		} catch {
			message = 'Network error';
		} finally {
			busyId = null;
		}
	}

	function ago(iso: string | null): string {
		if (!iso) return 'Not copied yet';
		const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
		if (minutes < 1) return 'Updated just now';
		if (minutes < 60) return `Updated ${minutes} min ago`;
		const hours = Math.round(minutes / 60);
		return hours < 24 ? `Updated ${hours} h ago` : `Updated ${new Date(iso).toLocaleDateString()}`;
	}
</script>

<section class="outside surface-lg" aria-labelledby="outside-title">
	<h2 id="outside-title">Other calendars</h2>
	<p class="lede">
		Show your Google, iCloud or Outlook calendar here, read-only. Its events count as busy time, so booking pages won't
		offer times you're already taken. Copies refresh about every 15 minutes.
	</p>

	{#if outside.length}
		<ul class="list">
			{#each outside as calendar (calendar.id)}
				<li class="item">
					<span class="dot" style="background: {CALENDAR_HEX[calendar.color]}"></span>
					<div class="item-text">
						<span class="item-name">{calendar.name}</span>
						<span class="item-meta">
							{calendar.source?.host} · {ago(calendar.source?.syncedAt ?? null)}
						</span>
						{#if calendar.source?.error}<span class="item-error">{calendar.source.error}</span>{/if}
					</div>
					<label class="check">
						<input
							type="checkbox"
							checked={calendar.source?.details}
							disabled={busyId === calendar.id}
							onchange={(event) => act(calendar, 'PATCH', { details: event.currentTarget.checked })}
						/>
						Show titles
					</label>
					<button type="button" class="btn-ghost small" disabled={busyId === calendar.id} onclick={() => act(calendar, 'POST')}>
						Refresh
					</button>
					<button
						type="button"
						class="icon-button"
						aria-label={`Remove ${calendar.name}`}
						disabled={busyId === calendar.id}
						onclick={() => act(calendar, 'DELETE')}
					>
						<Icon name="delete-bin-line" size={16} />
					</button>
				</li>
			{/each}
		</ul>
	{/if}

	<form class="add" onsubmit={add}>
		<label class="field grow">
			<span>Secret iCal link</span>
			<input type="url" inputmode="url" autocomplete="off" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" bind:value={url} required />
		</label>
		<label class="field">
			<span>Name</span>
			<input type="text" maxlength="80" placeholder="Work (Google)" bind:value={name} />
		</label>
		<div class="field">
			<span id="outside-color">Color</span>
			<div class="swatches" role="radiogroup" aria-labelledby="outside-color">
				{#each CALENDAR_COLORS as option (option)}
					<button
						type="button"
						class="swatch"
						role="radio"
						aria-checked={color === option}
						aria-label={option}
						style="background: {CALENDAR_HEX[option]}"
						onclick={() => (color = option)}
					></button>
				{/each}
			</div>
		</div>
		<label class="check">
			<input type="checkbox" bind:checked={details} />
			Copy event titles and places (otherwise just "Busy")
		</label>
		<button type="submit" class="btn-primary" disabled={adding || !url.trim()}>{adding ? 'Adding…' : 'Add calendar'}</button>
	</form>

	{#if message}<p class="message" role="status">{message}</p>{/if}

	<button type="button" class="help-toggle" aria-expanded={help} onclick={() => (help = !help)}>
		<Icon name={help ? 'arrow-down-s-line' : 'arrow-right-s-line'} size={16} /> Where do I find the link?
	</button>
	{#if help}
		<ul class="help">
			<li>
				<strong>Google Calendar:</strong> on the web, open Settings, pick the calendar under "Settings for my calendars",
				then copy "Secret address in iCal format".
			</li>
			<li>
				<strong>iCloud:</strong> in Calendar on icloud.com, click the share icon next to the calendar, turn on "Public
				Calendar", and copy the link.
			</li>
			<li>
				<strong>Outlook:</strong> Settings → Calendar → Shared calendars → Publish a calendar. Choose "Can view all
				details", then copy the ICS link.
			</li>
			<li>Anyone with that link can see the calendar, so CloudMail stores it encrypted. Remove it here any time.</li>
		</ul>
	{/if}
</section>

<style>
	.outside {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1rem;
		border-radius: 0.75rem;
		font-size: 0.875rem;
	}

	h2 {
		font-size: 1rem;
		font-weight: 600;
	}

	.lede,
	.item-meta,
	.message,
	.help {
		color: var(--color-text-secondary);
	}

	.list {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.item {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem 0.75rem;
		padding: 0.5rem 0;
		box-shadow: inset 0 -1px 0 var(--color-line);
	}

	.dot {
		flex-shrink: 0;
		width: 0.75rem;
		height: 0.75rem;
		border-radius: 9999px;
	}

	.item-text {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 12rem;
	}

	.item-name {
		font-weight: 600;
	}

	.item-meta {
		font-size: 0.8125rem;
	}

	.item-error {
		font-size: 0.8125rem;
		color: var(--color-danger, #c0392b);
	}

	.add {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.75rem;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.field.grow {
		flex: 1 1 18rem;
		min-width: 0;
	}

	.field input {
		padding: 0.4375rem 0.625rem;
		border-radius: 0.5rem;
		font-size: 0.875rem;
		color: var(--color-text);
		background: var(--color-surface);
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.swatches {
		display: flex;
		gap: 0.375rem;
		padding: 0.375rem 0;
	}

	.swatch {
		width: 1.25rem;
		height: 1.25rem;
		border-radius: 9999px;
	}

	.swatch[aria-checked='true'] {
		box-shadow:
			0 0 0 2px var(--color-surface),
			0 0 0 4px var(--color-text);
	}

	.check {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.8125rem;
	}

	.small {
		padding: 0.25rem 0.625rem;
		font-size: 0.8125rem;
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

	.help-toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		align-self: flex-start;
		font-size: 0.8125rem;
		color: var(--color-link);
	}

	.help {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		padding-left: 1.25rem;
		font-size: 0.8125rem;
		list-style: disc;
	}
</style>
