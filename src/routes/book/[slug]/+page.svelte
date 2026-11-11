<script lang="ts">
	import { page as current } from '$app/state';
	import Icon from '#lib/components/Icon.svelte';
	import SlotPicker, { type PickerSlot } from '#lib/components/booking/SlotPicker.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const page = $derived(data.page);

	let zone = $state(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
	let duration = $state(0);
	let step = $state<'pick' | 'details' | 'done'>('pick');
	let chosen = $state<PickerSlot | null>(null);
	let notice = $state('');

	let name = $state('');
	let email = $state('');
	let phone = $state('');
	let answers = $state<Record<string, string>>({});
	let showGuests = $state(false);
	let guests = $state('');
	let note = $state('');
	let sending = $state(false);
	let formError = $state('');
	let booked = $state<{ start: string; end: string; invited: boolean } | null>(null);

	$effect(() => {
		if (!duration) duration = page.durations[0];
	});

	const ICONS: Record<string, string> = {
		video: 'vidicon-line',
		phone_guest: 'phone-line',
		phone_host: 'phone-line',
		in_person: 'map-pin-line',
		custom: 'map-pin-line'
	};

	async function loadSlots(from: Date, to: Date): Promise<PickerSlot[]> {
		const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString(), duration: String(duration) });
		const res = await fetch(`/api/book/${page.slug}/slots?${params}`);
		if (!res.ok) throw new Error('slots');
		return (await res.json()).slots;
	}

	// A time offered in an email (?t=…&d=…): if it's still open, go straight to the details.
	let offered = $state(false);
	$effect(() => {
		if (offered || !duration) return;
		offered = true;
		const t = current.url.searchParams.get('t');
		const d = Number(current.url.searchParams.get('d'));
		if (!t || !Number.isFinite(Date.parse(t))) return;
		if (page.durations.includes(d)) duration = d;
		const start = new Date(Date.parse(t));
		loadSlots(new Date(start.getTime() - 3_600_000), new Date(start.getTime() + 86_400_000))
			.then((list) => {
				const match = list.find((slot) => Date.parse(slot.start) === start.getTime());
				if (match) pick(match);
				else notice = 'That time was just taken. Here are the times still open.';
			})
			.catch(() => undefined);
	});

	function pick(slot: PickerSlot) {
		chosen = slot;
		step = 'details';
		formError = '';
		notice = '';
	}

	const fmt = (iso: string, options: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleString(undefined, { ...options, timeZone: zone });
	const whenText = (slot: { start: string; end: string }) =>
		`${fmt(slot.start, { hour: 'numeric', minute: '2-digit' })} – ${fmt(slot.end, { hour: 'numeric', minute: '2-digit' })}, ${fmt(slot.start, {
			weekday: 'long',
			month: 'long',
			day: 'numeric',
			year: 'numeric'
		})}`;

	const ERRORS: Record<string, string> = {
		taken: 'That time was just taken. Pick another one.',
		name: 'Add your name.',
		email: 'Check your email address.',
		phone: 'Add a phone number we can reach you on, with its country code if you’re outside the US.',
		answers: 'Answer the questions marked as required.',
		guests: 'Check the guest addresses (up to three).',
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
				body: JSON.stringify({
					start: chosen.start,
					duration,
					name,
					email,
					phone,
					answers,
					guests: guests
						.split(/[\s,;]+/)
						.map((item) => item.trim())
						.filter(Boolean),
					note,
					timezone: zone
				})
			});
			const body = await res.json().catch(() => null);
			if (!res.ok) {
				formError = ERRORS[body?.error] ?? "Couldn't book that time. Try again.";
				if (body?.error === 'taken') {
					step = 'pick';
					chosen = null;
					notice = formError;
				}
				return;
			}
			booked = body;
			step = 'done';
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

<main class="wrap">
	<article class="card" class:wide={step === 'pick'}>
		<aside class="info">
			{#if step === 'details'}
				<button type="button" class="back" aria-label="Back to times" onclick={() => (step = 'pick')}>
					<Icon name="arrow-left-line" size={20} />
				</button>
			{/if}
			<p class="host">{page.host}</p>
			<h1>{page.title}</h1>
			<ul class="facts">
				<li><Icon name="time-line" size={18} /> {duration} min</li>
				{#if page.location}<li><Icon name={ICONS[page.location.kind] ?? 'map-pin-line'} size={18} /> {page.location.label}</li>{/if}
				{#if chosen && step !== 'pick'}
					<li class="strong"><Icon name="calendar-event-line" size={18} /> {whenText(booked ?? chosen)}</li>
					<li><Icon name="global-line" size={18} /> {zone.replace(/_/g, ' ')}</li>
				{/if}
			</ul>
			{#if page.description && step === 'pick'}<p class="description">{page.description}</p>{/if}
			{#if page.durations.length > 1 && step === 'pick'}
				<div class="lengths" role="radiogroup" aria-label="Meeting length">
					{#each page.durations as option (option)}
						<button type="button" role="radio" aria-checked={duration === option} class:active={duration === option} onclick={() => (duration = option)}>
							{option} min
						</button>
					{/each}
				</div>
			{/if}
		</aside>

		<section class="main">
			{#if step === 'pick'}
				<h2>Select a date and time</h2>
				{#if notice}<p class="notice" role="status">{notice}</p>{/if}
				<SlotPicker load={loadSlots} bind:zone reloadKey={String(duration)} selected={chosen?.start ?? null} onPick={pick} />
			{:else if step === 'details'}
				<h2>Enter details</h2>
				<form class="form" onsubmit={book}>
					<label>
						<span>Name <b aria-hidden="true">*</b></span>
						<input type="text" autocomplete="name" maxlength="60" required bind:value={name} />
					</label>
					<label>
						<span>Email <b aria-hidden="true">*</b></span>
						<input type="email" autocomplete="email" maxlength="254" required bind:value={email} />
					</label>
					{#if page.allowGuests}
						{#if showGuests}
							<label>
								<span>Guest emails (up to three)</span>
								<input type="text" inputmode="email" placeholder="pat@example.com, lee@example.com" bind:value={guests} />
							</label>
						{:else}
							<button type="button" class="pill" onclick={() => (showGuests = true)}>Add guests</button>
						{/if}
					{/if}
					{#if page.askPhone !== 'off'}
						<label>
							<span>Phone number {#if page.askPhone === 'required'}<b aria-hidden="true">*</b>{/if}</span>
							<input
								type="tel"
								autocomplete="tel"
								maxlength="24"
								placeholder="+1 615 555 0100"
								required={page.askPhone === 'required'}
								bind:value={phone}
							/>
						</label>
					{/if}
					{#each page.questions as question (question.id)}
						<label>
							<span>{question.label} {#if question.required}<b aria-hidden="true">*</b>{/if}</span>
							{#if question.long}
								<textarea rows="3" maxlength="2000" required={question.required} bind:value={answers[question.id]}></textarea>
							{:else}
								<input type="text" maxlength="300" required={question.required} bind:value={answers[question.id]} />
							{/if}
						</label>
					{/each}
					<label>
						<span>Please share anything that will help prepare for our meeting.</span>
						<textarea rows="3" maxlength="1000" bind:value={note}></textarea>
					</label>
					{#if formError}<p class="error" role="alert">{formError}</p>{/if}
					<button type="submit" class="primary" disabled={sending}>{sending ? 'Scheduling…' : 'Schedule event'}</button>
				</form>
			{:else if booked}
				<div class="done" aria-live="polite">
					<span class="check"><Icon name="check-line" size={22} /></span>
					<h2>You're scheduled</h2>
					<p>
						{booked.invited
							? `A calendar invitation is on its way to ${email}.`
							: `${page.host} has it on their calendar.`}
					</p>
					{#if booked.invited}
						<p class="muted-line">To reschedule or cancel, use the link in that email.</p>
					{/if}
				</div>
			{/if}
		</section>
	</article>
	<footer class="foot">Scheduling by CloudMail</footer>
</main>

<style>
	:global(body) {
		background: var(--color-surface-muted);
	}

	.wrap {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1rem;
		min-height: 100dvh;
		padding: 2.5rem 1rem;
		color: var(--color-text);
	}

	.card {
		display: grid;
		grid-template-columns: 18rem minmax(0, 1fr);
		width: min(100%, 56rem);
		min-height: 34rem;
		border-radius: 0.875rem;
		background: var(--color-surface);
		box-shadow:
			0 1px 2px rgb(0 0 0 / 0.04),
			0 8px 28px rgb(0 0 0 / 0.07),
			inset 0 0 0 1px var(--color-line);
	}

	.card.wide {
		width: min(100%, 64rem);
	}

	@media (max-width: 780px) {
		.card,
		.card.wide {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.info {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		padding: 1.75rem 1.5rem;
		box-shadow: inset -1px 0 0 var(--color-line);
	}

	@media (max-width: 780px) {
		.info {
			box-shadow: inset 0 -1px 0 var(--color-line);
		}
	}

	.back {
		display: inline-flex;
		align-self: flex-start;
		margin-bottom: 0.5rem;
		padding: 0.5rem;
		border-radius: 9999px;
		color: var(--color-link);
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.host {
		font-weight: 600;
		color: var(--color-text-secondary);
	}

	h1 {
		font-size: 1.625rem;
		font-weight: 700;
		line-height: 1.2;
		overflow-wrap: anywhere;
	}

	.facts {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		margin-top: 0.75rem;
		font-weight: 600;
		color: var(--color-text-secondary);
	}

	.facts li {
		display: flex;
		align-items: flex-start;
		gap: 0.625rem;
		overflow-wrap: anywhere;
	}

	.facts li.strong {
		color: var(--color-text);
	}

	.description {
		margin-top: 0.75rem;
		white-space: pre-wrap;
		color: var(--color-text-secondary);
	}

	.lengths {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.75rem;
	}

	.lengths button {
		padding: 0.375rem 0.875rem;
		border-radius: 9999px;
		font-size: 0.875rem;
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.lengths button.active {
		color: var(--color-on-accent);
		background: var(--color-link);
		box-shadow: none;
	}

	.main {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		padding: 1.75rem 1.75rem 2rem;
		min-width: 0;
	}

	h2 {
		font-size: 1.25rem;
		font-weight: 700;
	}

	.notice {
		padding: 0.625rem 0.875rem;
		border-radius: 0.5rem;
		font-size: 0.875rem;
		background: var(--color-surface-muted);
	}

	.form {
		display: flex;
		flex-direction: column;
		gap: 1.125rem;
		max-width: 28rem;
	}

	.form label {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		font-size: 0.875rem;
		font-weight: 600;
	}

	.form b {
		color: var(--color-danger, #c0392b);
	}

	.form input,
	.form textarea {
		padding: 0.625rem 0.75rem;
		border-radius: 0.5rem;
		font: inherit;
		font-weight: 400;
		color: var(--color-text);
		background: var(--color-surface);
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.form input:focus,
	.form textarea:focus {
		outline: none;
		box-shadow: inset 0 0 0 2px var(--color-link);
	}

	.pill {
		align-self: flex-start;
		padding: 0.375rem 1rem;
		border-radius: 9999px;
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--color-link);
		box-shadow: inset 0 0 0 1px var(--color-link);
	}

	.primary {
		align-self: flex-start;
		padding: 0.75rem 1.5rem;
		border-radius: 9999px;
		font-weight: 600;
		color: var(--color-on-accent);
		background: var(--color-link);
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
		gap: 0.625rem;
		padding-top: 2rem;
	}

	.check {
		display: inline-flex;
		padding: 0.5rem;
		border-radius: 9999px;
		color: var(--color-on-accent);
		background: #2f9e5b;
	}

	.muted-line {
		color: var(--color-text-secondary);
	}

	.foot {
		font-size: 0.75rem;
		color: var(--color-text-secondary);
	}
</style>
