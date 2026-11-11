<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '#lib/components/Icon.svelte';
	import SlotPicker, { type PickerSlot } from '#lib/components/booking/SlotPicker.svelte';

	type View = {
		page: {
			slug: string;
			title: string;
			host: string;
			location: { kind: string; label: string } | null;
		};
		booking: {
			name: string;
			start: string;
			end: string;
			duration: number;
			status: 'confirmed' | 'cancelled' | 'changed';
			canChange: boolean;
			canReschedule: boolean;
		};
	};

	/** The link's token lives after "#", so it never reaches a server log. */
	let token = $state('');
	let view = $state<View | null>(null);
	let missing = $state(false);
	let zone = $state(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
	let mode = $state<'view' | 'reschedule' | 'confirm-move' | 'cancel'>('view');
	let newSlot = $state<PickerSlot | null>(null);
	let reason = $state('');
	let busy = $state(false);
	let message = $state('');
	let error = $state('');

	async function call(body: Record<string, unknown>): Promise<{ ok: boolean; data: Record<string, unknown> | null }> {
		const res = await fetch('/api/book/manage', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ token, ...body })
		});
		return { ok: res.ok, data: await res.json().catch(() => null) };
	}

	onMount(async () => {
		token = decodeURIComponent(location.hash.slice(1));
		if (!token) {
			missing = true;
			return;
		}
		try {
			const { ok, data } = await call({ action: 'view' });
			if (ok && data) view = data as unknown as View;
			else missing = true;
		} catch {
			missing = true;
		}
	});

	const fmt = (iso: string, options: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleString(undefined, { ...options, timeZone: zone });
	const whenText = (slot: { start: string; end: string }) =>
		`${fmt(slot.start, { weekday: 'long', month: 'long', day: 'numeric' })}, ${fmt(slot.start, { hour: 'numeric', minute: '2-digit' })} – ${fmt(slot.end, {
			hour: 'numeric',
			minute: '2-digit',
			timeZoneName: 'short'
		})}`;

	async function loadSlots(from: Date, to: Date): Promise<PickerSlot[]> {
		const { ok, data } = await call({ action: 'slots', from: from.toISOString(), to: to.toISOString() });
		if (!ok || !data) throw new Error('slots');
		return data.slots as PickerSlot[];
	}

	const ERRORS: Record<string, string> = {
		taken: 'That time was just taken. Pick another one.',
		cancelled: 'This meeting was already canceled.',
		past: 'This meeting has already started, so it can’t be changed here.',
		changed: 'The host changed this meeting, so it can’t be changed here. Reply to the invite to reach them.',
		too_many: 'This meeting has been moved twice already. Reply to the invite to find another time.',
		slow_down: 'Too many changes right now. Wait a while, or reply to the invite.'
	};

	async function act(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
		busy = true;
		error = '';
		try {
			const { ok, data } = await call(body);
			if (!ok) {
				error = ERRORS[String(data?.error)] ?? 'Something went wrong. Try again.';
				return null;
			}
			return data ?? {};
		} catch {
			error = 'Network error. Try again.';
			return null;
		} finally {
			busy = false;
		}
	}

	async function move() {
		if (!newSlot || !view) return;
		const result = await act({ action: 'reschedule', start: newSlot.start });
		if (!result) {
			if (error === ERRORS.taken) mode = 'reschedule';
			return;
		}
		// The old link stopped working; this page now uses the new one (also in the updated invite).
		const next = String(result.manageUrl ?? '');
		if (next.includes('#')) {
			token = next.slice(next.indexOf('#') + 1);
			history.replaceState(history.state, '', `#${token}`);
		}
		view.booking = {
			...view.booking,
			start: String(result.start),
			end: String(result.end),
			canReschedule: false
		};
		const again = await call({ action: 'view' });
		if (again.ok && again.data) view = again.data as unknown as View;
		message = 'Rescheduled. Everyone invited gets the new time.';
		mode = 'view';
	}

	async function cancel(event: SubmitEvent) {
		event.preventDefault();
		if (!view || !(await act({ action: 'cancel', reason }))) return;
		view.booking = { ...view.booking, status: 'cancelled', canChange: false, canReschedule: false };
		message = 'Canceled. Everyone invited was told.';
		mode = 'view';
	}
</script>

<svelte:head>
	<title>{view ? `${view.page.title} · ${view.page.host}` : 'Your meeting'}</title>
	<meta name="robots" content="noindex" />
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<main class="wrap">
	{#if missing}
		<article class="card narrow">
			<section class="main">
				<h2>This link isn't valid anymore</h2>
				<p class="muted">If the meeting was moved, use the link in the newest invitation email. You can also reply to the invite.</p>
			</section>
		</article>
	{:else if !view}
		<p class="muted">Loading…</p>
	{:else}
		{@const page = view.page}
		{@const booking = view.booking}
		<article class="card" class:wide={mode === 'reschedule'}>
			<aside class="info">
				<p class="host">{page.host}</p>
				<h1>{page.title}</h1>
				<ul class="facts">
					<li class:struck={booking.status === 'cancelled'}>
						<Icon name="calendar-event-line" size={18} />
						{whenText(booking)}
					</li>
					<li><Icon name="time-line" size={18} /> {booking.duration} min</li>
					{#if page.location}
						<li>
							<Icon
								name={page.location.kind === 'video' ? 'vidicon-line' : page.location.kind.startsWith('phone') ? 'phone-line' : 'map-pin-line'}
								size={18}
							/>
							{page.location.label}
						</li>
					{/if}
				</ul>
			</aside>

			<section class="main">
				{#if message}<p class="status" role="status"><Icon name="checkbox-circle-line" size={18} /> {message}</p>{/if}
				{#if error}<p class="error" role="alert">{error}</p>{/if}

				{#if mode === 'view'}
					{#if booking.status === 'cancelled'}
						<h2>This meeting is canceled</h2>
						<a class="again" href={`/book/${page.slug}`}>Book a new time</a>
					{:else if booking.status === 'changed'}
						<h2>{page.host} changed this meeting</h2>
						<p class="muted">It can't be changed from this link anymore. Reply to the invite to reach {page.host}.</p>
					{:else if !booking.canChange}
						<h2>This meeting has started</h2>
						<p class="muted">It can’t be changed here anymore. Reply to the invite to reach {page.host}.</p>
					{:else}
						<h2>Hi {booking.name}, need to make a change?</h2>
						<div class="actions">
							{#if booking.canReschedule}
								<button type="button" class="primary" onclick={() => (mode = 'reschedule')}>Reschedule</button>
							{/if}
							<button type="button" class="secondary" onclick={() => (mode = 'cancel')}>Cancel meeting</button>
						</div>
						{#if !booking.canReschedule}
							<p class="muted">It's been moved twice already. To find another time, reply to the invite.</p>
						{/if}
					{/if}
				{:else if mode === 'reschedule'}
					<h2>Pick a new time</h2>
					<SlotPicker
						load={loadSlots}
						bind:zone
						selected={newSlot?.start ?? null}
						onPick={(slot) => {
							newSlot = slot;
							mode = 'confirm-move';
						}}
					/>
					<button type="button" class="link" onclick={() => (mode = 'view')}>Keep the current time</button>
				{:else if mode === 'confirm-move' && newSlot}
					<h2>Move it to this time?</h2>
					<p class="change">
						<span class="old">{whenText(booking)}</span><Icon name="arrow-right-line" size={16} /><strong>{whenText(newSlot)}</strong>
					</p>
					<div class="actions">
						<button type="button" class="primary" disabled={busy} onclick={move}>{busy ? 'Moving…' : 'Confirm new time'}</button>
						<button type="button" class="secondary" disabled={busy} onclick={() => (mode = 'reschedule')}>Pick another</button>
					</div>
				{:else if mode === 'cancel'}
					<h2>Cancel this meeting?</h2>
					<form class="form" onsubmit={cancel}>
						<label>
							<span>Reason (optional, shared with {page.host})</span>
							<textarea rows="3" maxlength="500" bind:value={reason}></textarea>
						</label>
						<div class="actions">
							<button type="submit" class="danger" disabled={busy}>{busy ? 'Canceling…' : 'Cancel meeting'}</button>
							<button type="button" class="secondary" disabled={busy} onclick={() => (mode = 'view')}>Keep it</button>
						</div>
					</form>
				{/if}
			</section>
		</article>
	{/if}
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
		width: min(100%, 52rem);
		min-height: 22rem;
		border-radius: 0.875rem;
		background: var(--color-surface);
		box-shadow:
			0 1px 2px rgb(0 0 0 / 0.04),
			0 8px 28px rgb(0 0 0 / 0.07),
			inset 0 0 0 1px var(--color-line);
	}

	.card.narrow {
		grid-template-columns: minmax(0, 1fr);
		width: min(100%, 32rem);
		min-height: 0;
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

	.host {
		font-weight: 600;
		color: var(--color-text-secondary);
	}

	h1 {
		font-size: 1.5rem;
		font-weight: 700;
		line-height: 1.2;
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
	}

	.struck {
		text-decoration: line-through;
	}

	.main {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 1.125rem;
		padding: 1.75rem;
		min-width: 0;
	}

	.main > :global(.picker) {
		align-self: stretch;
	}

	h2 {
		font-size: 1.25rem;
		font-weight: 700;
	}

	.muted {
		color: var(--color-text-secondary);
	}

	.status {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.625rem 0.875rem;
		border-radius: 0.5rem;
		font-weight: 600;
		color: #2f7a4d;
		background: color-mix(in srgb, #2f9e5b 12%, transparent);
	}

	.error {
		color: var(--color-danger, #c0392b);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.625rem;
	}

	.primary,
	.secondary,
	.danger {
		padding: 0.6875rem 1.25rem;
		border-radius: 9999px;
		font-weight: 600;
	}

	.primary {
		color: var(--color-on-accent);
		background: var(--color-link);
	}

	.secondary {
		color: var(--color-text);
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.danger {
		color: #fff;
		background: var(--color-danger, #c0392b);
	}

	button:disabled {
		opacity: 0.6;
	}

	.link,
	.again {
		font-weight: 600;
		color: var(--color-link);
	}

	.change {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}

	.old {
		text-decoration: line-through;
		color: var(--color-text-secondary);
	}

	.form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		width: min(100%, 28rem);
	}

	.form label {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		font-size: 0.875rem;
		font-weight: 600;
	}

	.form textarea {
		padding: 0.625rem 0.75rem;
		border-radius: 0.5rem;
		font: inherit;
		font-weight: 400;
		color: var(--color-text);
		background: var(--color-surface);
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.foot {
		font-size: 0.75rem;
		color: var(--color-text-secondary);
	}
</style>
