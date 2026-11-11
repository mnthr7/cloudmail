<script lang="ts" module>
	export type PickerSlot = { start: string; end: string };
</script>

<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import { addDays, daysInMonth, formatDate, localToUtc, utcToLocal, weekday, type LocalDate } from '#lib/calendar/time.ts';

	/**
	 * Pick a day on a month calendar, then a time on that day. Days with open
	 * times stand out; everything is shown in the visitor's chosen time zone.
	 */
	let {
		load,
		zone = $bindable(),
		reloadKey = '',
		selected = null,
		onPick
	}: {
		/** Open times between two instants. */
		load: (from: Date, to: Date) => Promise<PickerSlot[]>;
		zone: string;
		/** Changes when the times on offer change (another meeting length). */
		reloadKey?: string;
		selected?: string | null;
		onPick: (slot: PickerSlot) => void;
	} = $props();

	const zones: string[] = (() => {
		try {
			return (Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf('timeZone');
		} catch {
			return [zone];
		}
	})();

	const today = (() => {
		const now = utcToLocal(Date.now(), zone);
		return { year: now.year, month: now.month, day: now.day };
	})();

	let month = $state({ year: today.year, month: today.month });
	let slots = $state<PickerSlot[]>([]);
	let loading = $state(true);
	let failed = $state(false);
	let day = $state<string | null>(null);

	const keyOf = (iso: string) => formatDate(utcToLocal(Date.parse(iso), zone));

	const byDay = $derived.by(() => {
		const map = new Map<string, PickerSlot[]>();
		for (const slot of slots) {
			const key = keyOf(slot.start);
			map.set(key, [...(map.get(key) ?? []), slot]);
		}
		return map;
	});

	/** Weeks of the month on screen, Sunday first; null pads the edges. */
	const weeks = $derived.by(() => {
		const first: LocalDate = { year: month.year, month: month.month, day: 1 };
		const cells: Array<LocalDate | null> = Array.from({ length: weekday(first) }, () => null);
		for (let d = 1; d <= daysInMonth(month.year, month.month); d++) cells.push({ ...first, day: d });
		while (cells.length % 7) cells.push(null);
		return Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7));
	});

	const isCurrentMonth = $derived(month.year === today.year && month.month === today.month);
	const monthLabel = $derived(
		new Date(Date.UTC(month.year, month.month - 1, 15)).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })
	);

	let request = 0;
	async function refresh() {
		const id = ++request;
		loading = true;
		failed = false;
		const first: LocalDate = { year: month.year, month: month.month, day: 1 };
		const next = addDays(first, daysInMonth(month.year, month.month));
		try {
			const list = await load(
				new Date(localToUtc({ ...first, hour: 0, minute: 0 }, zone)),
				new Date(localToUtc({ ...next, hour: 0, minute: 0 }, zone))
			);
			if (id !== request) return;
			slots = list;
			// Keep the chosen day if it still has times; otherwise the first day that does.
			const days = [...new Set(list.map((slot) => keyOf(slot.start)))];
			if (!day || !days.includes(day)) day = days[0] ?? null;
		} catch {
			if (id === request) failed = true;
		} finally {
			if (id === request) loading = false;
		}
	}

	$effect(() => {
		void month.year;
		void month.month;
		void zone;
		void reloadKey;
		refresh();
	});

	function step(by: number) {
		const index = month.year * 12 + (month.month - 1) + by;
		month = { year: Math.floor(index / 12), month: (index % 12) + 1 };
		day = null;
	}

	const timeLabel = (iso: string) =>
		new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: zone });
	const dayHeading = $derived(
		day
			? new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })
			: ''
	);
	const nowIn = (name: string) => {
		try {
			return new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: name });
		} catch {
			return '';
		}
	};
</script>

<div class="picker">
	<div class="calendar">
		<div class="month-nav">
			<button type="button" aria-label="Previous month" disabled={isCurrentMonth} onclick={() => step(-1)}>
				<Icon name="arrow-left-s-line" size={20} />
			</button>
			<span class="month" aria-live="polite">{monthLabel}</span>
			<button type="button" aria-label="Next month" onclick={() => step(1)}>
				<Icon name="arrow-right-s-line" size={20} />
			</button>
		</div>
		<div class="grid" aria-busy={loading}>
			{#each ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as name (name)}<span class="weekday" aria-hidden="true">{name}</span>{/each}
			{#each weeks.flat() as cell, index (index)}
				{#if cell}
					{@const key = formatDate(cell)}
					{@const open = byDay.has(key)}
					<button
						type="button"
						class="day"
						class:open
						class:chosen={day === key}
						class:today={key === formatDate(today)}
						disabled={!open}
						aria-pressed={day === key}
						aria-label={new Date(`${key}T12:00:00Z`).toLocaleDateString(undefined, {
							weekday: 'long',
							month: 'long',
							day: 'numeric',
							timeZone: 'UTC'
						}) + (open ? ', times open' : ', no times')}
						onclick={() => (day = key)}>{cell.day}</button
					>
				{:else}
					<span></span>
				{/if}
			{/each}
		</div>
		<label class="zone">
			<span>Time zone</span>
			<span class="zone-select">
				<Icon name="global-line" size={15} />
				<select bind:value={zone}>
					{#each zones.includes(zone) ? zones : [zone, ...zones] as name (name)}
						<option value={name}>{name.replace(/_/g, ' ')} ({nowIn(name)})</option>
					{/each}
				</select>
			</span>
		</label>
	</div>

	<div class="times">
		{#if failed}
			<p class="note" role="alert">Couldn't load open times. <button type="button" class="link" onclick={refresh}>Try again</button></p>
		{:else if loading && !slots.length}
			<p class="note">Finding open times…</p>
		{:else if !day}
			<p class="note">
				No open times in {monthLabel}.
				<button type="button" class="link" onclick={() => step(1)}>Try next month</button>
			</p>
		{:else}
			<h3>{dayHeading}</h3>
			<div class="list">
				{#each byDay.get(day) ?? [] as slot (slot.start)}
					<button type="button" class="time" class:chosen={selected === slot.start} onclick={() => onPick(slot)}>
						{timeLabel(slot.start)}
					</button>
				{/each}
			</div>
		{/if}
	</div>
</div>

<style>
	.picker {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 13rem;
		gap: 1.5rem;
	}

	@media (max-width: 640px) {
		.picker {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.month-nav {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 1rem;
		margin-bottom: 0.75rem;
	}

	.month-nav button {
		display: inline-flex;
		padding: 0.375rem;
		border-radius: 9999px;
		color: var(--color-text);
	}

	.month-nav button:hover:not(:disabled) {
		background: var(--color-surface-muted);
	}

	.month-nav button:disabled {
		opacity: 0.3;
	}

	.month {
		min-width: 9rem;
		text-align: center;
		font-weight: 600;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
		gap: 0.25rem;
		justify-items: center;
	}

	.weekday {
		padding-bottom: 0.25rem;
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--color-text-secondary);
	}

	.day {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		max-width: 2.75rem;
		aspect-ratio: 1;
		border-radius: 9999px;
		font-size: 0.9375rem;
		color: var(--color-text-secondary);
	}

	.day.open {
		font-weight: 600;
		color: var(--color-link);
		background: color-mix(in srgb, var(--color-link) 10%, transparent);
	}

	.day.open:hover {
		background: color-mix(in srgb, var(--color-link) 18%, transparent);
	}

	.day.chosen {
		color: var(--color-on-accent);
		background: var(--color-link);
	}

	.day.today:not(.chosen) {
		text-decoration: underline;
		text-underline-offset: 0.25rem;
	}

	.day:disabled {
		cursor: default;
		opacity: 0.55;
	}

	.zone {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin-top: 1rem;
		font-size: 0.8125rem;
		font-weight: 600;
	}

	.zone-select {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		font-weight: 400;
	}

	.zone select {
		min-width: 0;
		max-width: 100%;
		padding: 0.25rem 0;
		border: none;
		font: inherit;
		color: var(--color-text);
		background: transparent;
	}

	.times h3 {
		margin-bottom: 0.75rem;
		font-size: 0.9375rem;
		font-weight: 600;
	}

	.list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		max-height: 24rem;
		overflow-y: auto;
		padding-right: 0.25rem;
	}

	@media (max-width: 640px) {
		.list {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(6.5rem, 1fr));
			max-height: none;
		}
	}

	.time {
		padding: 0.6875rem 0.5rem;
		border-radius: 0.5rem;
		font-weight: 600;
		color: var(--color-link);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-link) 55%, transparent);
	}

	.time:hover {
		box-shadow: inset 0 0 0 2px var(--color-link);
	}

	.time.chosen {
		color: var(--color-on-accent);
		background: var(--color-link);
	}

	.note {
		font-size: 0.875rem;
		color: var(--color-text-secondary);
	}

	.link {
		color: var(--color-link);
		text-decoration: underline;
	}
</style>
