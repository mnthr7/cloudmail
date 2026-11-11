<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';

	/**
	 * Picks a few open times from one of your booking pages and hands back a
	 * block of time buttons to put in an email. Each button opens the booking
	 * page with that time already chosen, so replying is one click.
	 */
	let { onInsert, onClose }: { onInsert: (html: string) => void; onClose: () => void } = $props();

	type Page = { id: string; slug: string; title: string; durations: number[]; enabled: boolean };
	type Slot = { start: string; end: string };

	const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	const MAX = 6;

	let pages = $state<Page[]>([]);
	let slug = $state('');
	let duration = $state(0);
	let slots = $state<Slot[]>([]);
	let picked = $state<string[]>([]);
	let loading = $state(true);
	let failed = $state('');

	const pageNow = $derived(pages.find((item) => item.slug === slug));

	$effect(() => {
		fetch('/api/calendar/booking-pages')
			.then((res) => (res.ok ? res.json() : { pages: [] }))
			.then((body: { pages: Page[] }) => {
				pages = body.pages.filter((item) => item.enabled);
				slug = pages[0]?.slug ?? '';
				duration = pages[0]?.durations[0] ?? 0;
				if (!pages.length) loading = false;
			})
			.catch(() => {
				failed = "Couldn't load your booking pages.";
				loading = false;
			});
	});

	let request = 0;
	$effect(() => {
		if (!slug || !duration) return;
		const id = ++request;
		loading = true;
		failed = '';
		const from = new Date();
		const to = new Date(from.getTime() + 14 * 86_400_000);
		const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString(), duration: String(duration) });
		fetch(`/api/book/${slug}/slots?${params}`)
			.then((res) => (res.ok ? res.json() : Promise.reject(new Error('slots'))))
			.then((body: { slots: Slot[] }) => {
				if (id !== request) return;
				slots = body.slots;
				// A sensible start: the first two times on each of the first three days.
				const perDay = new Map<string, number>();
				picked = body.slots
					.filter((slot) => {
						const key = dayKey(slot.start);
						const count = perDay.get(key) ?? 0;
						if (perDay.size >= 3 && !perDay.has(key)) return false;
						perDay.set(key, count + 1);
						return count < 2;
					})
					.map((slot) => slot.start)
					.slice(0, MAX);
			})
			.catch(() => {
				if (id === request) failed = "Couldn't load open times.";
			})
			.finally(() => {
				if (id === request) loading = false;
			});
	});

	const dayKey = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: zone });
	const dayLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: zone });
	const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: zone });
	const zoneName = (() => {
		try {
			return (
				new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longGeneric' })
					.formatToParts(new Date())
					.find((part) => part.type === 'timeZoneName')?.value ?? zone
			);
		} catch {
			return zone;
		}
	})();

	const days = $derived.by(() => {
		const map = new Map<string, Slot[]>();
		for (const slot of slots) map.set(dayKey(slot.start), [...(map.get(dayKey(slot.start)) ?? []), slot]);
		return [...map.entries()].slice(0, 7);
	});

	function toggle(start: string) {
		if (picked.includes(start)) picked = picked.filter((item) => item !== start);
		else if (picked.length < MAX) picked = [...picked, start].sort();
	}

	const escape = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

	function insert() {
		if (!pageNow || picked.length === 0) return;
		const base = `${location.origin}/book/${encodeURIComponent(pageNow.slug)}`;
		const buttons = picked
			.map((start) => {
				const href = `${base}?t=${encodeURIComponent(start)}&d=${duration}`;
				return `<a href="${escape(href)}" style="display:inline-block;margin:0 6px 6px 0;padding:8px 12px;border:1px solid #2f6fdb;border-radius:8px;color:#2f6fdb;text-decoration:none;font-weight:600">${escape(
					`${dayLabel(start)} · ${timeLabel(start)}`
				)}</a>`;
			})
			.join('');
		onInsert(
			`<div><p>Do any of these times work for a ${duration}-minute ${escape(pageNow.title)}? (${escape(zoneName)})</p>` +
				`<p>${buttons}</p>` +
				`<p style="font-size:13px"><a href="${escape(base)}">See all open times</a></p></div><p><br></p>`
		);
	}
</script>

<div class="offer" role="dialog" aria-label="Offer times">
	<header>
		<strong>Offer times</strong>
		<button type="button" class="icon-btn" aria-label="Close" onclick={onClose}><Icon name="close-line" size={16} /></button>
	</header>
	{#if !loading && pages.length === 0 && !failed}
		<p class="muted">Make a booking page first (Calendar → Booking page). Times offered here come from it.</p>
	{:else}
		<div class="row">
			{#if pages.length > 1}
				<select bind:value={slug} aria-label="Booking page" onchange={() => (duration = pageNow?.durations[0] ?? 0)}>
					{#each pages as item (item.id)}<option value={item.slug}>{item.title}</option>{/each}
				</select>
			{/if}
			{#if pageNow && pageNow.durations.length > 1}
				<select bind:value={duration} aria-label="Length">
					{#each pageNow.durations as minutes (minutes)}<option value={minutes}>{minutes} min</option>{/each}
				</select>
			{/if}
		</div>
		{#if failed}
			<p class="muted" role="alert">{failed}</p>
		{:else if loading}
			<p class="muted">Finding open times…</p>
		{:else if days.length === 0}
			<p class="muted">No open times in the next two weeks.</p>
		{:else}
			<p class="muted">Pick up to {MAX}. Times show in {zoneName}; they open in the reader's own time zone.</p>
			<div class="days">
				{#each days as [key, list] (key)}
					<div class="day">
						<span class="day-name">{dayLabel(list[0].start)}</span>
						<div class="times">
							{#each list as slot (slot.start)}
								<button
									type="button"
									class="time"
									class:on={picked.includes(slot.start)}
									aria-pressed={picked.includes(slot.start)}
									disabled={!picked.includes(slot.start) && picked.length >= MAX}
									onclick={() => toggle(slot.start)}>{timeLabel(slot.start)}</button
								>
							{/each}
						</div>
					</div>
				{/each}
			</div>
			<button type="button" class="insert" disabled={!picked.length} onclick={insert}>
				Insert {picked.length} time{picked.length === 1 ? '' : 's'}
			</button>
		{/if}
	{/if}
</div>

<style>
	.offer {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		width: min(26rem, calc(100vw - 2rem));
		max-height: 26rem;
		padding: 0.875rem;
		border-radius: 0.75rem;
		font-size: 0.8125rem;
		color: var(--color-text);
		background: var(--color-surface);
		box-shadow:
			0 10px 30px rgb(0 0 0 / 0.16),
			inset 0 0 0 1px var(--color-line);
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.icon-btn {
		display: inline-flex;
		padding: 0.25rem;
		border-radius: 0.375rem;
		color: var(--color-muted);
	}

	.row {
		display: flex;
		gap: 0.5rem;
	}

	.row select {
		padding: 0.25rem 0.375rem;
		border-radius: 0.375rem;
		font: inherit;
		color: var(--color-text);
		background: var(--color-surface);
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.muted {
		color: var(--color-text-secondary);
	}

	.days {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		overflow-y: auto;
	}

	.day-name {
		display: block;
		margin-bottom: 0.25rem;
		font-weight: 600;
	}

	.times {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3125rem;
	}

	.time {
		padding: 0.25rem 0.5rem;
		border-radius: 0.375rem;
		color: var(--color-link);
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.time.on {
		color: var(--color-on-accent);
		background: var(--color-link);
		box-shadow: none;
	}

	.time:disabled {
		opacity: 0.4;
	}

	.insert {
		align-self: flex-end;
		padding: 0.4375rem 0.875rem;
		border-radius: 0.5rem;
		font-weight: 600;
		color: var(--color-on-accent);
		background: var(--color-accent);
	}

	.insert:disabled {
		opacity: 0.5;
	}
</style>
