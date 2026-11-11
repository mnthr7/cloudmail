<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const page = $derived(data.page);

	const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	const DAY = 86_400_000;

	function startOfDay(date: Date): Date {
		return new Date(date.getFullYear(), date.getMonth(), date.getDate());
	}

	let duration = $state(0);
	let weekStart = $state(startOfDay(new Date()));
	let slots = $state<Array<{ start: string; end: string }>>([]);
	let loading = $state(true);
	let loadError = $state('');
	let chosen = $state<{ start: string; end: string } | null>(null);
	let name = $state('');
	let email = $state('');
	let note = $state('');
	let sending = $state(false);
	let formError = $state('');
	let booked = $state<{ start: string; end: string; invited: boolean } | null>(null);

	$effect(() => {
		if (!duration) duration = page.durations[0];
	});

	const days = $derived(Array.from({ length: 7 }, (_, i) => new Date(weekStart.getTime() + i * DAY + 3_600_000)).map(startOfDay));

	const byDay = $derived.by(() => {
		const map = new Map<string, Array<{ start: string; end: string }>>();
		for (const slot of slots) {
			const key = startOfDay(new Date(slot.start)).toDateString();
			map.set(key, [...(map.get(key) ?? []), slot]);
		}
		return map;
	});

	let request = 0;
	async function load() {
		if (!duration) return;
		const id = ++request;
		loading = true;
		loadError = '';
		try {
			const end = new Date(days[6].getTime() + DAY);
			const params = new URLSearchParams({ from: weekStart.toISOString(), to: end.toISOString(), duration: String(duration) });
			const res = await fetch(`/api/book/${page.slug}/slots?${params}`);
			if (!res.ok) throw new Error('slots');
			const body = await res.json();
			if (id === request) slots = body.slots;
		} catch {
			if (id === request) loadError = "Couldn't load open times. Try again.";
		} finally {
			if (id === request) loading = false;
		}
	}

	$effect(() => {
		void weekStart.getTime();
		void duration;
		load();
	});

	const today = startOfDay(new Date());
	const canGoBack = $derived(weekStart.getTime() > today.getTime());

	function move(step: number) {
		const next = new Date(weekStart.getTime() + step * 7 * DAY + 3_600_000);
		weekStart = startOfDay(next) < today ? today : startOfDay(next);
		chosen = null;
	}

	const dayLabel = (date: Date) => date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
	const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
	const fullLabel = (iso: string) =>
		new Date(iso).toLocaleString(undefined, { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });

	const ERRORS: Record<string, string> = {
		taken: 'That time was just taken. Pick another one.',
		name: 'Add your name.',
		email: 'Check your email address.',
		too_many: 'You already have a few meetings booked here.',
		slow_down: 'Too many tries. Wait a few minutes and try again.',
		durations: 'Pick a meeting length.'
	};

	async function book(event: SubmitEvent) {
		event.preventDefault();
		if (!chosen || sending) return;
		sending = true;
		formError = '';
		try {
			const res = await fetch(`/api/book/${page.slug}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ start: chosen.start, duration, name, email, note })
			});
			const body = await res.json().catch(() => null);
			if (!res.ok) {
				formError = ERRORS[body?.error] ?? "Couldn't book that time. Try again.";
				if (body?.error === 'taken') {
					chosen = null;
					load();
				}
				return;
			}
			booked = body;
		} catch {
			formError = 'Network error. Try again.';
		} finally {
			sending = false;
		}
	}
</script>

<svelte:head>
	<title>{page.title} · {page.host}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main class="book">
	<header class="intro">
		<p class="host">{page.host}</p>
		<h1>{page.title}</h1>
		{#if page.description}<p class="description">{page.description}</p>{/if}
		<p class="facts">
			<span><Icon name="time-line" size={15} /> {duration} minutes</span>
			{#if page.location}<span><Icon name="map-pin-line" size={15} /> {page.location}</span>{/if}
			<span><Icon name="global-line" size={15} /> Times in {zone.replace(/_/g, ' ')}</span>
		</p>
	</header>

	{#if booked}
		<section class="done" aria-live="polite">
			<Icon name="checkbox-circle-line" size={28} />
			<h2>You're booked</h2>
			<p>{fullLabel(booked.start)} – {timeLabel(booked.end)}</p>
			<p class="muted">
				{booked.invited ? `An invite is on its way to ${email}.` : `${page.host} has it on their calendar.`}
			</p>
		</section>
	{:else}
		{#if page.durations.length > 1}
			<div class="lengths" role="radiogroup" aria-label="Meeting length">
				{#each page.durations as option (option)}
					<button
						type="button"
						role="radio"
						aria-checked={duration === option}
						class:active={duration === option}
						onclick={() => {
							duration = option;
							chosen = null;
						}}>{option} min</button
					>
				{/each}
			</div>
		{/if}

		{#if chosen}
			<form class="details" onsubmit={book}>
				<p class="picked">
					<strong>{fullLabel(chosen.start)} – {timeLabel(chosen.end)}</strong>
					<button type="button" class="link" onclick={() => (chosen = null)}>Change</button>
				</p>
				<label>
					<span>Your name</span>
					<input type="text" autocomplete="name" maxlength="60" required bind:value={name} />
				</label>
				<label>
					<span>Email</span>
					<input type="email" autocomplete="email" maxlength="254" required bind:value={email} />
				</label>
				<label>
					<span>Anything to share? (optional)</span>
					<textarea rows="3" maxlength="1000" bind:value={note}></textarea>
				</label>
				{#if formError}<p class="error" role="alert">{formError}</p>{/if}
				<button type="submit" class="primary" disabled={sending}>{sending ? 'Booking…' : 'Book it'}</button>
			</form>
		{:else}
			<div class="week-nav">
				<button type="button" aria-label="Earlier" disabled={!canGoBack} onclick={() => move(-1)}>
					<Icon name="arrow-left-s-line" size={20} />
				</button>
				<span>{dayLabel(days[0])} – {dayLabel(days[6])}</span>
				<button type="button" aria-label="Later" onclick={() => move(1)}>
					<Icon name="arrow-right-s-line" size={20} />
				</button>
			</div>
			{#if loadError}
				<p class="error" role="alert">{loadError}</p>
			{:else}
				<div class="days" aria-busy={loading}>
					{#each days as day (day.getTime())}
						{@const list = byDay.get(day.toDateString()) ?? []}
						<section class="day">
							<h2>{dayLabel(day)}</h2>
							{#if list.length}
								<div class="times">
									{#each list as slot (slot.start)}
										<button type="button" class="time" onclick={() => (chosen = slot)}>{timeLabel(slot.start)}</button>
									{/each}
								</div>
							{:else}
								<p class="muted">{loading ? '…' : 'No open times'}</p>
							{/if}
						</section>
					{/each}
				</div>
			{/if}
		{/if}
	{/if}
	<footer class="foot">Scheduling by CloudMail</footer>
</main>

<style>
	:global(body) {
		background: var(--color-bg, var(--color-surface-muted));
	}

	.book {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		max-width: 46rem;
		margin: 0 auto;
		padding: 2.5rem 1rem 3rem;
		color: var(--color-text);
	}

	.intro {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.host {
		font-size: 0.875rem;
		color: var(--color-text-secondary);
	}

	h1 {
		font-size: 1.625rem;
		font-weight: 650;
		line-height: 1.2;
	}

	.description {
		white-space: pre-wrap;
		color: var(--color-text-secondary);
	}

	.facts {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem 1rem;
		font-size: 0.875rem;
		color: var(--color-text-secondary);
	}

	.facts span {
		display: inline-flex;
		align-items: center;
		gap: 0.3125rem;
	}

	.lengths {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.lengths button,
	.time {
		padding: 0.4375rem 0.875rem;
		border-radius: 9999px;
		font-size: 0.875rem;
		background: var(--color-surface);
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.lengths button.active {
		color: var(--color-on-accent);
		background: var(--color-accent);
		box-shadow: none;
	}

	.week-nav {
		display: flex;
		align-items: center;
		justify-content: space-between;
		font-weight: 600;
	}

	.week-nav button {
		display: inline-flex;
		padding: 0.375rem;
		border-radius: 0.5rem;
	}

	.week-nav button:disabled {
		opacity: 0.35;
	}

	.days {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(10.5rem, 1fr));
		gap: 0.75rem;
	}

	.day {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.75rem;
		border-radius: 0.75rem;
		background: var(--color-surface);
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.day h2 {
		font-size: 0.875rem;
		font-weight: 600;
	}

	.times {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
	}

	.time {
		color: var(--color-link);
	}

	.time:hover {
		box-shadow: inset 0 0 0 1px var(--color-link);
	}

	.muted {
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.details {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
		max-width: 28rem;
		padding: 1.25rem;
		border-radius: 0.875rem;
		background: var(--color-surface);
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.picked {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.details label {
		display: flex;
		flex-direction: column;
		gap: 0.3125rem;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.details input,
	.details textarea {
		padding: 0.5rem 0.625rem;
		border-radius: 0.5rem;
		font: inherit;
		font-size: 0.9375rem;
		color: var(--color-text);
		background: var(--color-surface);
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.link {
		font-size: 0.875rem;
		color: var(--color-link);
	}

	.primary {
		align-self: flex-start;
		padding: 0.5625rem 1.25rem;
		border-radius: 0.5rem;
		font-weight: 600;
		color: var(--color-on-accent);
		background: var(--color-accent);
	}

	.primary:disabled {
		opacity: 0.6;
	}

	.error {
		font-size: 0.875rem;
		color: var(--color-danger, #c0392b);
	}

	.done {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.375rem;
		padding: 1.5rem;
		border-radius: 0.875rem;
		background: var(--color-surface);
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.done :global(i) {
		color: var(--color-accent);
	}

	.done h2 {
		font-size: 1.25rem;
		font-weight: 650;
	}

	.foot {
		margin-top: 1rem;
		font-size: 0.75rem;
		color: var(--color-text-secondary);
	}
</style>
