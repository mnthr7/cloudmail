<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import { describeRule, parseRule } from '#lib/calendar/recurrence.ts';
	import { presetLabels, presetOf, ruleFor, type RepeatEnd, type RepeatPreset } from '#lib/calendar/presets.ts';
	import { addDays, formatDate, parseDate } from '#lib/calendar/time.ts';
	import type { AttendeeView, CalendarInfo, Occurrence } from '#lib/calendar/types.ts';

	/**
	 * Create or edit an event. For a repeating event, saving or deleting asks
	 * whether it's this occurrence or the whole series.
	 */
	let {
		calendars,
		addresses = [],
		occurrence = null,
		start = null,
		onDone,
		onClose
	}: {
		calendars: CalendarInfo[];
		/** Your addresses, for choosing where invites go out from. */
		addresses?: string[];
		/** The occurrence being edited; null creates a new event. */
		occurrence?: Occurrence | null;
		/** For a new event: where it starts ("2026-11-10T09:00" or "2026-11-10" for all-day). */
		start?: string | null;
		/** `close` false keeps the editor open to show a problem; `notice` is shown on the calendar. */
		onDone: (close: boolean, notice?: string) => void;
		onClose: () => void;
	} = $props();

	const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	const zones: string[] = (() => {
		try {
			return (Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf('timeZone');
		} catch {
			return [browserZone];
		}
	})();

	function addMinutes(time: string, minutes: number): { time: string; nextDay: boolean } {
		const [hour, minute] = time.split(':').map(Number);
		const total = hour * 60 + minute + minutes;
		const wrapped = ((total % 1440) + 1440) % 1440;
		return {
			time: `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`,
			nextDay: total >= 1440
		};
	}

	// The form, filled from the occurrence or the clicked slot (set once when the editor opens).
	const initial = (() => {
		const defaultCalendar = calendars.find((calendar) => calendar.isDefault) ?? calendars[0];
		if (occurrence) {
			const allDay = occurrence.allDay;
			const startDate = occurrence.startLocal.slice(0, 10);
			const endDate = allDay
				? formatDate(addDays(parseDate(occurrence.endLocal)!, -1))
				: occurrence.endLocal.slice(0, 10);
			// Repeat settings belong to the series; an edited copy can't change them.
			const seriesRule = occurrence.eventId === occurrence.seriesId ? occurrence.rrule : null;
			const repeat = presetOf(seriesRule, parseDate(startDate)!, occurrence.timezone);
			return {
				calendarId: occurrence.calendarId,
				title: occurrence.title,
				allDay,
				startDate,
				endDate,
				startTime: allDay ? '09:00' : occurrence.startLocal.slice(11, 16),
				endTime: allDay ? '10:00' : occurrence.endLocal.slice(11, 16),
				timezone: occurrence.timezone,
				location: occurrence.location ?? '',
				description: occurrence.description ?? '',
				busy: occurrence.transparency !== 'free',
				preset: repeat.preset,
				end: repeat.end,
				existingRule: seriesRule
			};
		}
		const slot = start ?? '';
		const allDay = slot.length === 10;
		const today = new Date();
		const startDate =
			slot.slice(0, 10) ||
			formatDate({ year: today.getFullYear(), month: today.getMonth() + 1, day: today.getDate() });
		const startTime = allDay ? '09:00' : slot.slice(11, 16) || '09:00';
		const later = addMinutes(startTime, 60);
		return {
			calendarId: defaultCalendar?.id ?? '',
			title: '',
			allDay,
			startDate,
			endDate: later.nextDay ? formatDate(addDays(parseDate(startDate)!, 1)) : startDate,
			startTime,
			endTime: later.time,
			timezone: defaultCalendar?.timezone ?? browserZone,
			location: '',
			description: '',
			busy: true,
			preset: 'none' as RepeatPreset,
			end: { kind: 'never' } as RepeatEnd,
			existingRule: null as string | null
		};
	})();

	let form = $state(structuredClone(initial));
	let endKind = $state<RepeatEnd['kind']>(initial.end.kind);
	let endCount = $state(initial.end.kind === 'after' ? initial.end.count : 10);
	let endOn = $state(initial.end.kind === 'on' ? formatDate(initial.end.date) : '');
	let busy = $state(false);
	let error = $state('');
	/** Set while asking "this event or all events?". */
	let asking = $state<'save' | 'delete' | null>(null);

	// Guests: only for events you organize (an accepted invite belongs to its organizer).
	const invited = $derived(!!occurrence?.organizer);
	let guests = $state<AttendeeView[]>([]);
	let guestInput = $state('');
	let sendFrom = $state('');
	// Guests load after the editor opens (an event you're editing); a new event starts with none.
	let guestsLoaded = $state(false);
	let initialGuests = $state('');

	$effect(() => {
		if (!occurrence || occurrence.organizer) {
			guestsLoaded = true;
			return;
		}
		fetch(`/api/calendar/events/${occurrence.seriesId}`)
			.then((res) => (res.ok ? res.json() : null))
			.then((data) => {
				guests = data?.attendees ?? [];
				initialGuests = guests.map((guest) => guest.email).join(',');
				sendFrom = data?.sendFrom ?? '';
			})
			.finally(() => (guestsLoaded = true));
	});

	const GUEST = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

	function addGuests(text: string) {
		const own = new Set(addresses.map((address) => address.toLowerCase()));
		const bad: string[] = [];
		for (const raw of text.split(/[\s,;]+/)) {
			const email = raw.replace(/^<|>$/g, '').trim().toLowerCase();
			if (!email) continue;
			if (!GUEST.test(email)) {
				bad.push(raw);
				continue;
			}
			if (own.has(email) || guests.some((guest) => guest.email === email)) continue;
			guests = [...guests, { email, name: null, partstat: 'NEEDS-ACTION' }];
		}
		guestInput = bad.join(' ');
		if (bad.length) error = `Not an email address: ${bad.join(', ')}`;
	}

	function guestKey(event: KeyboardEvent) {
		if (event.key === 'Enter' || event.key === ',' || event.key === ';') {
			event.preventDefault();
			addGuests(guestInput);
		} else if (event.key === 'Backspace' && !guestInput && guests.length) {
			guests = guests.slice(0, -1);
		}
	}

	const STATUS: Record<string, { icon: string; label: string }> = {
		ACCEPTED: { icon: 'checkbox-circle-line', label: 'Going' },
		TENTATIVE: { icon: 'question-line', label: 'Maybe' },
		DECLINED: { icon: 'close-circle-line', label: 'Not going' },
		'NEEDS-ACTION': { icon: 'time-line', label: 'No answer yet' }
	};

	const editing = $derived(occurrence !== null);
	const isSeries = $derived(!!occurrence && occurrence.recurring && occurrence.eventId === occurrence.seriesId);
	const isEditedCopy = $derived(!!occurrence && occurrence.eventId !== occurrence.seriesId);
	const startDay = $derived(parseDate(form.startDate));
	const labels = $derived(startDay ? presetLabels(startDay) : []);

	const ERRORS: Record<string, string> = {
		title: 'Give it a title, up to 200 characters.',
		time: 'Check the start and end: the end has to come after the start.',
		timezone: 'Pick a time zone.',
		rrule: "That repeat setting isn't valid.",
		calendar: 'Pick a calendar.',
		occurrence: 'That occurrence no longer exists. Reload and try again.',
		missing: 'That event no longer exists.',
		text: 'Location or notes are too long.',
		guests: 'Check the guest addresses (up to 50).',
		from: "You can't send invites from that address."
	};

	function payload(includeRepeat: boolean): Record<string, unknown> {
		const day = parseDate(form.startDate);
		let endDate = form.endDate;
		if (!form.allDay && form.endTime <= form.startTime && form.endDate === form.startDate && day) {
			// An end before the start runs past midnight.
			endDate = formatDate(addDays(day, 1));
		}
		const body: Record<string, unknown> = {
			// The list can arrive after the editor opened; fall back to the default calendar then.
			calendarId: form.calendarId || (calendars.find((calendar) => calendar.isDefault) ?? calendars[0])?.id,
			title: form.title,
			location: form.location,
			description: form.description,
			allDay: form.allDay,
			timezone: form.timezone,
			transparency: form.busy ? 'busy' : 'free',
			start: form.allDay ? form.startDate : `${form.startDate}T${form.startTime}`,
			end: form.allDay
				? formatDate(addDays(parseDate(form.endDate) ?? day!, 1))
				: `${endDate}T${form.endTime}`
		};
		if (!invited && guestsLoaded) {
			if (guestInput.trim()) addGuests(guestInput);
			body.guests = guests.map((guest) => ({ email: guest.email, name: guest.name }));
			if (sendFrom) body.sendFrom = sendFrom;
		}
		if (includeRepeat && day) {
			const end: RepeatEnd =
				endKind === 'after'
					? { kind: 'after', count: Number(endCount) || 1 }
					: endKind === 'on' && parseDate(endOn)
						? { kind: 'on', date: parseDate(endOn)! }
						: { kind: 'never' };
			const untouched =
				form.preset === initial.preset &&
				endKind === initial.end.kind &&
				(endKind !== 'after' || Number(endCount) === (initial.end.kind === 'after' ? initial.end.count : -1)) &&
				(endKind !== 'on' || endOn === (initial.end.kind === 'on' ? formatDate(initial.end.date) : ''));
			body.rrule = untouched && initial.existingRule ? initial.existingRule : ruleFor(form.preset, day, end, form.timezone, form.existingRule);
		}
		return body;
	}

	async function send(url: string, method: string, body?: Record<string, unknown>) {
		busy = true;
		error = '';
		try {
			const res = await fetch(url, {
				method,
				headers: body ? { 'Content-Type': 'application/json' } : undefined,
				body: body ? JSON.stringify(body) : undefined
			});
			const data = await res.json().catch(() => null);
			if (!res.ok) {
				error = ERRORS[data?.error] ?? 'Could not save that.';
				return;
			}
			if (data?.invites?.error) {
				if (method === 'DELETE') {
					// The event is gone; say so on the calendar instead of keeping the editor open.
					onDone(true, `Deleted, but guests couldn't be told: ${data.invites.error}`);
					return;
				}
				// Saved, but the email didn't go out: say so rather than closing quietly.
				error = `Saved, but invites couldn't be sent: ${data.invites.error}`;
				onDone(false);
				return;
			}
			onDone(true);
		} catch {
			error = 'Network error';
		} finally {
			busy = false;
			asking = null;
		}
	}

	function save(event: SubmitEvent) {
		event.preventDefault();
		if (!form.title.trim()) {
			error = ERRORS.title;
			return;
		}
		if (!occurrence) return send('/api/calendar/events', 'POST', payload(true));
		if (isSeries) {
			asking = 'save';
			return;
		}
		return send(`/api/calendar/events/${occurrence.eventId}`, 'PATCH', payload(!isEditedCopy));
	}

	function saveScope(scope: 'one' | 'all') {
		if (!occurrence) return;
		if (scope === 'one') {
			send(`/api/calendar/events/${occurrence.seriesId}`, 'PATCH', { ...payload(false), occurrence: occurrence.occurrence });
		} else {
			// The whole series keeps its own first date; only times and details change from here.
			const body = payload(true);
			const series = body as Record<string, string>;
			const firstDate = seriesFirstDate;
			if (!form.allDay) {
				series.start = `${firstDate}T${form.startTime}`;
				const crossesMidnight = form.endTime <= form.startTime;
				const endDay = crossesMidnight ? formatDate(addDays(parseDate(firstDate)!, 1)) : firstDate;
				series.end = `${endDay}T${form.endTime}`;
			} else {
				const length =
					(Date.parse(`${form.endDate}T00:00Z`) - Date.parse(`${form.startDate}T00:00Z`)) / 86_400_000 + 1;
				series.start = firstDate;
				series.end = formatDate(addDays(parseDate(firstDate)!, length));
			}
			send(`/api/calendar/events/${occurrence.seriesId}`, 'PATCH', body);
		}
	}

	function remove() {
		if (!occurrence) return;
		if (isSeries) {
			asking = 'delete';
			return;
		}
		send(`/api/calendar/events/${occurrence.eventId}`, 'DELETE');
	}

	function removeScope(scope: 'one' | 'all') {
		if (!occurrence) return;
		if (scope === 'one') {
			send(`/api/calendar/events/${occurrence.seriesId}?occurrence=${encodeURIComponent(occurrence.occurrence ?? '')}`, 'DELETE');
		} else {
			send(`/api/calendar/events/${occurrence.seriesId}`, 'DELETE');
		}
	}

	/** The series' own first date, which "all events" edits keep. */
	const seriesFirstDate = $derived(occurrence?.seriesStartLocal.slice(0, 10) ?? form.startDate);

	const ruleText = $derived.by(() => {
		if (form.preset !== 'custom' || !form.existingRule) return '';
		try {
			return describeRule(parseRule(form.existingRule, form.timezone));
		} catch {
			return form.existingRule;
		}
	});

	function onKey(event: KeyboardEvent) {
		if (event.key === 'Escape') onClose();
	}
</script>

<svelte:window onkeydown={onKey} />

<div class="scrim" role="presentation" onclick={onClose}></div>
<div class="dialog surface-lg" role="dialog" aria-modal="true" aria-labelledby="event-editor-title">
	<form onsubmit={save}>
		<header class="dialog-head">
			<h2 id="event-editor-title">{editing ? 'Edit event' : 'New event'}</h2>
			<button type="button" class="icon-button" aria-label="Close" onclick={onClose}>
				<Icon name="close-line" size={18} />
			</button>
		</header>

		<label class="field">
			<span class="sr-only">Title</span>
			<!-- svelte-ignore a11y_autofocus -->
			<input class="title-input" type="text" maxlength="200" placeholder="Add a title" bind:value={form.title} autofocus />
		</label>

		<label class="check-row">
			<input type="checkbox" bind:checked={form.allDay} />
			All day
		</label>

		{#if form.allDay}
			<div class="row">
				<label class="field"><span>Starts</span><input type="date" bind:value={form.startDate} required /></label>
				<label class="field"><span>Ends</span><input type="date" bind:value={form.endDate} min={form.startDate} required /></label>
			</div>
		{:else}
			<div class="row">
				<label class="field"><span>Date</span><input type="date" bind:value={form.startDate} required /></label>
				<label class="field"><span>Starts</span><input type="time" step="300" bind:value={form.startTime} required /></label>
				<label class="field"><span>Ends</span><input type="time" step="300" bind:value={form.endTime} required /></label>
			</div>
			{#if form.endTime <= form.startTime}
				<p class="hint">Ends the next day.</p>
			{/if}
		{/if}

		{#if !isEditedCopy}
			<div class="row">
				<label class="field grow">
					<span>Repeat</span>
					<select bind:value={form.preset}>
						{#each labels as option (option.value)}
							<option value={option.value}>{option.label}</option>
						{/each}
						{#if form.existingRule && form.preset === 'custom'}
							<option value="custom">{ruleText || 'Custom'}</option>
						{/if}
					</select>
				</label>
				{#if form.preset !== 'none'}
					<label class="field">
						<span>Ends</span>
						<select bind:value={endKind}>
							<option value="never">Never</option>
							<option value="on">On a date</option>
							<option value="after">After a number of times</option>
						</select>
					</label>
					{#if endKind === 'on'}
						<label class="field"><span>Last date</span><input type="date" bind:value={endOn} min={form.startDate} /></label>
					{:else if endKind === 'after'}
						<label class="field"><span>Times</span><input type="number" min="1" max="5000" bind:value={endCount} /></label>
					{/if}
				{/if}
			</div>
		{/if}

		{#if invited && occurrence?.organizer}
			<div class="organizer">
				<Icon name="mail-line" size={15} />
				<span>
					Organized by {occurrence.organizer.email.endsWith('@invalid')
						? 'someone else'
						: occurrence.organizer.name || occurrence.organizer.email}{occurrence.myStatus === 'tentative'
						? ' · You said maybe'
						: ' · You’re going'}. Changes here only affect your calendar.
				</span>
				{#if occurrence.sourceEmailId}<a href={`/mail/${occurrence.sourceEmailId}`}>Open the email</a>{/if}
			</div>
		{:else}
			<div class="field">
				<span>Guests</span>
				<div class="guests">
					{#each guests as guest (guest.email)}
						<span class="guest" title={STATUS[guest.partstat]?.label ?? guest.partstat}>
							<Icon name={STATUS[guest.partstat]?.icon ?? 'time-line'} size={13} />
							{guest.name || guest.email}
							<button
								type="button"
								aria-label={`Remove ${guest.email}`}
								onclick={() => (guests = guests.filter((item) => item.email !== guest.email))}
							>
								<Icon name="close-line" size={12} />
							</button>
						</span>
					{/each}
					<input
						type="email"
						multiple
						placeholder={guests.length ? '' : 'Add people by email'}
						bind:value={guestInput}
						onkeydown={guestKey}
						onblur={() => guestInput.trim() && addGuests(guestInput)}
						aria-label="Add guests"
					/>
				</div>
				{#if guests.length}
					<span class="hint">
						{editing && guests.map((guest) => guest.email).join(',') === initialGuests
							? 'Guests get the update when you save.'
							: 'Guests get an invite by email when you save.'}
					</span>
				{/if}
			</div>
			{#if guests.length && addresses.length > 1}
				<label class="field">
					<span>Send invites from</span>
					<select bind:value={sendFrom}>
						<option value="">Your default address</option>
						{#each addresses as address (address)}
							<option value={address}>{address}</option>
						{/each}
					</select>
				</label>
			{/if}
		{/if}

		<label class="field">
			<span>Location</span>
			<input type="text" maxlength="500" placeholder="Room, address, or video link" bind:value={form.location} />
		</label>
		<label class="field">
			<span>Notes</span>
			<textarea rows="3" maxlength="10000" bind:value={form.description}></textarea>
		</label>

		<div class="row">
			{#if calendars.length > 1}
				<label class="field">
					<span>Calendar</span>
					<select bind:value={form.calendarId}>
						{#each calendars as calendar (calendar.id)}
							<option value={calendar.id}>{calendar.name}</option>
						{/each}
					</select>
				</label>
			{/if}
			<label class="field grow">
				<span>Time zone</span>
				<select bind:value={form.timezone}>
					{#each zones.includes(form.timezone) ? zones : [form.timezone, ...zones] as zone (zone)}
						<option value={zone}>{zone.replace(/_/g, ' ')}</option>
					{/each}
				</select>
			</label>
			<label class="check-row">
				<input type="checkbox" bind:checked={form.busy} />
				Show as busy
			</label>
		</div>

		{#if error}<p class="error" role="alert">{error}</p>{/if}

		{#if asking}
			<div class="scope" role="group" aria-label="Which events">
				<p>{asking === 'save' ? 'Change' : 'Delete'} only this event, or every event in the series?</p>
				<div class="actions">
					<button type="button" class="btn-ghost" onclick={() => (asking = null)} disabled={busy}>Cancel</button>
					<button
						type="button"
						class="btn-ghost"
						disabled={busy}
						onclick={() => (asking === 'save' ? saveScope('one') : removeScope('one'))}
					>
						This event
					</button>
					<button
						type="button"
						class="btn-primary"
						disabled={busy}
						onclick={() => (asking === 'save' ? saveScope('all') : removeScope('all'))}
					>
						All events
					</button>
				</div>
			</div>
		{:else}
			<footer class="actions">
				{#if editing}
					<button type="button" class="btn-ghost danger" onclick={remove} disabled={busy}>
						<Icon name="delete-bin-line" size={15} /> Delete
					</button>
				{/if}
				<span class="spacer"></span>
				<button type="button" class="btn-ghost" onclick={onClose} disabled={busy}>Cancel</button>
				<button type="submit" class="btn-primary" disabled={busy}>Save</button>
			</footer>
		{/if}
	</form>
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
		width: min(34rem, calc(100vw - 2rem));
		max-height: calc(100dvh - 2rem);
		overflow-y: auto;
		padding: 1.25rem;
		border-radius: 0.875rem;
		background: var(--color-surface);
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.dialog-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.dialog-head h2 {
		font-size: 1.0625rem;
		font-weight: 600;
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

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.field.grow {
		flex: 1;
		min-width: 10rem;
	}

	.field input,
	.field select,
	.field textarea {
		padding: 0.4375rem 0.625rem;
		border-radius: 0.5rem;
		font: inherit;
		font-size: 0.875rem;
		color: var(--color-text);
		background: transparent;
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.title-input {
		font-size: 1.125rem !important;
		font-weight: 500;
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.75rem;
	}

	.check-row {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.875rem;
	}

	.hint {
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.error {
		font-size: 0.8125rem;
		color: var(--color-danger);
	}

	.actions {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem;
		justify-content: flex-end;
	}

	.spacer {
		flex: 1;
	}

	.danger {
		color: var(--color-danger);
	}

	.guests {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
		padding: 0.375rem;
		border-radius: 0.5rem;
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.guests input {
		flex: 1;
		min-width: 10rem;
		padding: 0.125rem 0.25rem;
		font: inherit;
		font-size: 0.875rem;
		color: var(--color-text);
		background: transparent;
		border: 0;
		outline: none;
	}

	.guest {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.125rem 0.25rem 0.125rem 0.5rem;
		border-radius: 9999px;
		font-size: 0.8125rem;
		color: var(--color-text);
		background: var(--color-surface-muted);
	}

	.guest button {
		display: inline-flex;
		padding: 0.125rem;
		border-radius: 9999px;
		color: var(--color-text-secondary);
	}

	.organizer {
		display: flex;
		align-items: flex-start;
		flex-wrap: wrap;
		gap: 0.375rem;
		padding: 0.625rem 0.75rem;
		border-radius: 0.625rem;
		font-size: 0.8125rem;
		background: var(--color-surface-muted);
	}

	.organizer a {
		color: var(--color-link);
	}

	.scope {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.75rem;
		border-radius: 0.625rem;
		background: var(--color-surface-muted);
		font-size: 0.875rem;
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
	}
</style>
