<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import type { CalendarInfo } from '#lib/calendar/types.ts';

	/** Your booking pages: a public link where people pick an open time on your calendar. */
	let { calendars, addresses = [] }: { calendars: CalendarInfo[]; addresses?: string[] } = $props();

	type Page = {
		id: string;
		slug: string;
		title: string;
		description: string | null;
		durations: number[];
		timezone: string;
		hours: Record<string, Array<[string, string]>>;
		bufferMinutes: number;
		minNoticeMinutes: number;
		horizonDays: number;
		maxPerDay: number;
		calendarId: string;
		sendFrom: string | null;
		location: string | null;
		enabled: boolean;
		locationKind: string;
		askPhone: 'off' | 'optional' | 'required';
		questions: Array<{ id: string; label: string; long: boolean; required: boolean }>;
		allowGuests: boolean;
		reminderMinutes: number;
	};

	const LOCATIONS = [
		['none', 'No location'],
		['video', 'Video call (Zoom, Google Meet, Teams…)'],
		['phone_guest', 'Phone call: I call them'],
		['phone_host', 'Phone call: they call me'],
		['in_person', 'In person'],
		['custom', 'Something else']
	] as const;
	const LOCATION_HINTS: Record<string, string> = {
		video: 'Your meeting link, e.g. https://zoom.us/j/… or https://meet.google.com/…',
		phone_host: 'Your phone number',
		in_person: 'Address',
		custom: 'Where or how you’ll meet'
	};
	const REMINDERS = [
		[0, 'No reminder'],
		[60, '1 hour before'],
		[120, '2 hours before'],
		[1440, '1 day before'],
		[2880, '2 days before']
	] as const;

	const DAYS = [
		['MO', 'Mon'],
		['TU', 'Tue'],
		['WE', 'Wed'],
		['TH', 'Thu'],
		['FR', 'Fri'],
		['SA', 'Sat'],
		['SU', 'Sun']
	] as const;
	const LENGTHS = [15, 20, 30, 45, 60, 90, 120];
	const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	const zones: string[] = (() => {
		try {
			return (Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf('timeZone');
		} catch {
			return [browserZone];
		}
	})();

	let pages = $state<Page[]>([]);
	let loaded = $state(false);
	let editing = $state<string | 'new' | null>(null);
	let saving = $state(false);
	let message = $state('');
	let copied = $state<string | null>(null);

	type Form = {
		title: string;
		slug: string;
		slugTouched: boolean;
		description: string;
		durations: number[];
		timezone: string;
		days: Record<string, { on: boolean; from: string; to: string }>;
		bufferMinutes: number;
		noticeHours: number;
		horizonDays: number;
		maxPerDay: number;
		calendarId: string;
		sendFrom: string;
		location: string;
		enabled: boolean;
		locationKind: string;
		askPhone: 'off' | 'optional' | 'required';
		questions: Array<{ id?: string; label: string; long: boolean; required: boolean }>;
		allowGuests: boolean;
		reminderMinutes: number;
	};

	function blank(): Form {
		return {
			title: '30-minute meeting',
			slug: '',
			slugTouched: false,
			description: '',
			durations: [30],
			timezone: browserZone,
			days: Object.fromEntries(
				DAYS.map(([key]) => [key, { on: !['SA', 'SU'].includes(key), from: '09:00', to: '17:00' }])
			),
			bufferMinutes: 10,
			noticeHours: 4,
			horizonDays: 30,
			maxPerDay: 8,
			calendarId: (calendars.find((calendar) => calendar.isDefault) ?? calendars[0])?.id ?? '',
			sendFrom: '',
			location: '',
			enabled: true,
			locationKind: 'video',
			askPhone: 'off',
			questions: [],
			allowGuests: true,
			reminderMinutes: 1440
		};
	}

	function fromPage(page: Page): Form {
		return {
			title: page.title,
			slug: page.slug,
			slugTouched: true,
			description: page.description ?? '',
			durations: [...page.durations],
			timezone: page.timezone,
			days: Object.fromEntries(
				DAYS.map(([key]) => {
					const window = page.hours[key]?.[0];
					return [key, { on: !!window, from: window?.[0] ?? '09:00', to: window?.[1] ?? '17:00' }];
				})
			),
			bufferMinutes: page.bufferMinutes,
			noticeHours: Math.round(page.minNoticeMinutes / 60),
			horizonDays: page.horizonDays,
			maxPerDay: page.maxPerDay,
			calendarId: page.calendarId,
			sendFrom: page.sendFrom ?? '',
			location: page.location ?? '',
			enabled: page.enabled,
			locationKind: page.locationKind,
			askPhone: page.askPhone,
			questions: page.questions.map((question) => ({ ...question })),
			allowGuests: page.allowGuests,
			reminderMinutes: page.reminderMinutes
		};
	}

	let form = $state<Form>(blank());

	function slugify(text: string): string {
		return text
			.toLowerCase()
			.normalize('NFKD')
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40);
	}

	$effect(() => {
		if (!form.slugTouched) form.slug = slugify(form.title);
	});

	async function load() {
		const res = await fetch('/api/calendar/booking-pages');
		if (res.ok) pages = (await res.json()).pages;
		loaded = true;
	}

	$effect(() => {
		load();
	});

	function open(target: Page | 'new') {
		message = '';
		if (target === 'new') {
			form = blank();
			editing = 'new';
		} else {
			form = fromPage(target);
			editing = target.id;
		}
	}

	const ERRORS: Record<string, string> = {
		slug: 'The link name can use lowercase letters, numbers and dashes (3 to 40 characters).',
		slug_taken: 'That link name is taken. Try another.',
		title: 'Add a title (up to 120 characters).',
		durations: 'Pick at least one meeting length (up to four).',
		hours: 'Check the hours: each day needs a start before its end.',
		timezone: 'Pick a time zone.',
		numbers: 'Check the numbers: buffer up to 120 minutes, notice up to 14 days, up to 120 days ahead, 1 to 50 a day.',
		calendar: 'Pick one of your calendars.',
		from: 'Pick one of your addresses.',
		limit: 'You can have up to 10 booking pages.',
		location: 'Check the location: a video link must start with https://, and a phone number needs at least 7 digits.',
		questions: 'Each question needs a label (up to 200 characters), and there can be up to five.'
	};

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (saving) return;
		saving = true;
		message = '';
		const hours = Object.fromEntries(
			Object.entries(form.days)
				.filter(([, day]) => day.on)
				.map(([key, day]) => [key, [[day.from, day.to]]])
		);
		const body = {
			title: form.title,
			slug: form.slug,
			description: form.description,
			durations: form.durations,
			timezone: form.timezone,
			hours,
			bufferMinutes: Number(form.bufferMinutes),
			minNoticeMinutes: Math.round(Number(form.noticeHours) * 60),
			horizonDays: Number(form.horizonDays),
			maxPerDay: Number(form.maxPerDay),
			calendarId: form.calendarId,
			sendFrom: form.sendFrom || null,
			location: form.location,
			enabled: form.enabled,
			locationKind: form.locationKind,
			askPhone: form.locationKind === 'phone_guest' ? 'required' : form.askPhone,
			questions: form.questions.filter((question) => question.label.trim()),
			allowGuests: form.allowGuests,
			reminderMinutes: Number(form.reminderMinutes)
		};
		try {
			const res = await fetch(editing === 'new' ? '/api/calendar/booking-pages' : `/api/calendar/booking-pages/${editing}`, {
				method: editing === 'new' ? 'POST' : 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			const result = await res.json().catch(() => null);
			if (!res.ok) {
				message = ERRORS[result?.error] ?? "Couldn't save. Try again.";
				return;
			}
			editing = null;
			message = 'Saved.';
			await load();
		} catch {
			message = 'Network error';
		} finally {
			saving = false;
		}
	}

	async function remove(page: Page) {
		if (!confirm(`Delete "${page.title}"? Its link stops working. Meetings already booked stay on your calendar.`)) return;
		await fetch(`/api/calendar/booking-pages/${page.id}`, { method: 'DELETE' });
		if (editing === page.id) editing = null;
		await load();
	}

	const linkOf = (slug: string) => `${location.origin}/book/${slug}`;

	async function copy(slug: string) {
		await navigator.clipboard?.writeText(linkOf(slug)).catch(() => undefined);
		copied = slug;
		setTimeout(() => (copied = null), 2000);
	}

	function toggleLength(minutes: number) {
		form.durations = form.durations.includes(minutes)
			? form.durations.filter((value) => value !== minutes)
			: [...form.durations, minutes].sort((a, b) => a - b);
	}
</script>

<section class="booking surface-lg" aria-labelledby="booking-title">
	<div class="head">
		<h2 id="booking-title">Booking pages</h2>
		{#if editing === null}
			<button type="button" class="btn-ghost small" onclick={() => open('new')}><Icon name="add-line" size={15} /> New page</button>
		{/if}
	</div>
	<p class="lede">
		Share a link and people pick an open time. It checks every calendar here, including your other calendars, and the
		meeting lands on your calendar with an invite sent to them.
	</p>

	{#if editing === null}
		{#if loaded && pages.length === 0}
			<p class="muted">No booking pages yet.</p>
		{/if}
		<ul class="list">
			{#each pages as page (page.id)}
				<li class="item">
					<div class="item-text">
						<span class="item-name">{page.title}{page.enabled ? '' : ' (off)'}</span>
						<a class="item-link" href={`/book/${page.slug}`} target="_blank" rel="noopener">{linkOf(page.slug)}</a>
						<span class="muted">{page.durations.join(', ')} min · {page.timezone.replace(/_/g, ' ')}</span>
					</div>
					<button type="button" class="btn-ghost small" onclick={() => copy(page.slug)}>{copied === page.slug ? 'Copied' : 'Copy link'}</button>
					<button type="button" class="btn-ghost small" onclick={() => open(page)}>Edit</button>
					<button type="button" class="icon-button" aria-label={`Delete ${page.title}`} onclick={() => remove(page)}>
						<Icon name="delete-bin-line" size={16} />
					</button>
				</li>
			{/each}
		</ul>
	{:else}
		<form class="form" onsubmit={save}>
			<div class="row">
				<label class="field grow">
					<span>Title</span>
					<input type="text" maxlength="120" required bind:value={form.title} />
				</label>
				<label class="field grow">
					<span>Link</span>
					<span class="slug">
						<span class="muted">/book/</span>
						<input
							type="text"
							maxlength="40"
							required
							bind:value={form.slug}
							oninput={() => (form.slugTouched = true)}
							pattern={'[a-z0-9][a-z0-9\\-]{1,38}[a-z0-9]'}
						/>
					</span>
				</label>
			</div>
			<label class="field">
				<span>Description (optional)</span>
				<textarea rows="2" maxlength="1000" bind:value={form.description}></textarea>
			</label>
			<div class="field">
				<span>Meeting lengths</span>
				<div class="chips">
					{#each LENGTHS as minutes (minutes)}
						<button
							type="button"
							class="chip"
							aria-pressed={form.durations.includes(minutes)}
							class:active={form.durations.includes(minutes)}
							onclick={() => toggleLength(minutes)}>{minutes} min</button
						>
					{/each}
				</div>
			</div>
			<div class="field">
				<span>Hours</span>
				<div class="hours">
					{#each DAYS as day (day[0])}
						{@const key = day[0]}
						{@const label = day[1]}
						<div class="hour-row">
							<label class="check"><input type="checkbox" bind:checked={form.days[key].on} /> {label}</label>
							{#if form.days[key].on}
								<input type="time" step="900" bind:value={form.days[key].from} aria-label={`${label} from`} />
								<span class="muted">to</span>
								<input type="time" step="900" bind:value={form.days[key].to} aria-label={`${label} until`} />
							{:else}
								<span class="muted">Unavailable</span>
							{/if}
						</div>
					{/each}
				</div>
			</div>
			<div class="row">
				<label class="field grow">
					<span>Time zone</span>
					<select bind:value={form.timezone}>
						{#each zones.includes(form.timezone) ? zones : [form.timezone, ...zones] as zone (zone)}
							<option value={zone}>{zone.replace(/_/g, ' ')}</option>
						{/each}
					</select>
				</label>
				<label class="field">
					<span>Gap between meetings (min)</span>
					<input type="number" min="0" max="120" step="5" bind:value={form.bufferMinutes} />
				</label>
				<label class="field">
					<span>Notice needed (hours)</span>
					<input type="number" min="0" max="336" bind:value={form.noticeHours} />
				</label>
				<label class="field">
					<span>Days ahead</span>
					<input type="number" min="1" max="120" bind:value={form.horizonDays} />
				</label>
				<label class="field">
					<span>Most a day</span>
					<input type="number" min="1" max="50" bind:value={form.maxPerDay} />
				</label>
			</div>
			<div class="row">
				<label class="field">
					<span>Location</span>
					<select bind:value={form.locationKind}>
						{#each LOCATIONS as option (option[0])}<option value={option[0]}>{option[1]}</option>{/each}
					</select>
				</label>
				{#if LOCATION_HINTS[form.locationKind]}
					<label class="field grow">
						<span>{LOCATION_HINTS[form.locationKind]}</span>
						<input type={form.locationKind === 'video' ? 'url' : 'text'} maxlength="500" required bind:value={form.location} />
					</label>
				{:else if form.locationKind === 'phone_guest'}
					<p class="hint grow">They’ll be asked for their number, and it goes in the invite.</p>
				{/if}
				{#if calendars.length > 1}
					<label class="field">
						<span>Add to calendar</span>
						<select bind:value={form.calendarId}>
							{#each calendars as calendar (calendar.id)}
								<option value={calendar.id}>{calendar.name}</option>
							{/each}
						</select>
					</label>
				{/if}
				{#if addresses.length > 1}
					<label class="field">
						<span>Invites come from</span>
						<select bind:value={form.sendFrom}>
							<option value="">Your default address</option>
							{#each addresses as address (address)}
								<option value={address}>{address}</option>
							{/each}
						</select>
					</label>
				{/if}
			</div>
			<div class="field">
				<span>What to ask</span>
				<div class="asks">
					<label class="check">
						Phone number
						<select bind:value={form.askPhone} disabled={form.locationKind === 'phone_guest'}>
							<option value="off">Don’t ask</option>
							<option value="optional">Optional</option>
							<option value="required">Required</option>
						</select>
					</label>
					<label class="check"><input type="checkbox" bind:checked={form.allowGuests} /> Let them add up to 3 guests</label>
				</div>
				{#each form.questions as question, index (index)}
					<div class="question">
						<input type="text" maxlength="200" placeholder="Your question" bind:value={question.label} aria-label={`Question ${index + 1}`} />
						<label class="check"><input type="checkbox" bind:checked={question.long} /> Long answer</label>
						<label class="check"><input type="checkbox" bind:checked={question.required} /> Required</label>
						<button
							type="button"
							class="icon-button"
							aria-label={`Remove question ${index + 1}`}
							onclick={() => (form.questions = form.questions.filter((_, i) => i !== index))}
						>
							<Icon name="close-line" size={15} />
						</button>
					</div>
				{/each}
				{#if form.questions.length < 5}
					<button
						type="button"
						class="btn-ghost small add-question"
						onclick={() => (form.questions = [...form.questions, { label: '', long: false, required: false }])}
					>
						<Icon name="add-line" size={15} /> Add a question
					</button>
				{/if}
			</div>
			<label class="field">
				<span>Reminder email to the guest</span>
				<select bind:value={form.reminderMinutes}>
					{#each REMINDERS as option (option[0])}<option value={option[0]}>{option[1]}</option>{/each}
				</select>
			</label>
			<label class="check"><input type="checkbox" bind:checked={form.enabled} /> Page is on (people can book)</label>
			<div class="actions">
				<button type="button" class="btn-ghost" onclick={() => (editing = null)} disabled={saving}>Cancel</button>
				<button type="submit" class="btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
			</div>
		</form>
	{/if}
	{#if message}<p class="muted" role="status">{message}</p>{/if}
</section>

<style>
	.booking {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1rem;
		border-radius: 0.75rem;
		font-size: 0.875rem;
	}

	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	h2 {
		font-size: 1rem;
		font-weight: 600;
	}

	.lede,
	.muted {
		color: var(--color-text-secondary);
	}

	.list {
		display: flex;
		flex-direction: column;
	}

	.item {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 0.75rem;
		padding: 0.5rem 0;
		box-shadow: inset 0 -1px 0 var(--color-line);
	}

	.item-text {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 14rem;
	}

	.item-name {
		font-weight: 600;
	}

	.item-link {
		overflow-wrap: anywhere;
		color: var(--color-link);
	}

	.form {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
	}

	.row {
		display: flex;
		flex-wrap: wrap;
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
		flex: 1 1 14rem;
		min-width: 0;
	}

	.field input,
	.field select,
	.field textarea,
	.hour-row input {
		padding: 0.375rem 0.5rem;
		border-radius: 0.5rem;
		font: inherit;
		font-size: 0.875rem;
		color: var(--color-text);
		background: var(--color-surface);
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.field input[type='number'] {
		width: 7rem;
	}

	.slug {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}

	.slug input {
		flex: 1;
		min-width: 0;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
	}

	.chip {
		padding: 0.25rem 0.75rem;
		border-radius: 9999px;
		font-size: 0.8125rem;
		color: var(--color-text);
		background: var(--color-surface);
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.chip.active {
		color: var(--color-on-accent);
		background: var(--color-accent);
		box-shadow: none;
	}

	.hours {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.hour-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		color: var(--color-text);
	}

	.hour-row .check {
		width: 4.5rem;
	}

	.check {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.8125rem;
		color: var(--color-text);
	}

	.asks {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1.25rem;
		margin-bottom: 0.25rem;
	}

	.asks select {
		margin-left: 0.25rem;
	}

	.question {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 0.75rem;
	}

	.question input[type='text'] {
		flex: 1 1 16rem;
		min-width: 0;
		padding: 0.375rem 0.5rem;
		border-radius: 0.5rem;
		font: inherit;
		font-size: 0.875rem;
		color: var(--color-text);
		background: var(--color-surface);
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.add-question {
		align-self: flex-start;
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}

	.hint {
		align-self: flex-end;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.grow {
		flex: 1 1 14rem;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
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
</style>
