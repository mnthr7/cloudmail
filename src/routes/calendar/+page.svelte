<script lang="ts">
	import { untrack } from 'svelte';
	import Icon from '#lib/components/Icon.svelte';
	import EventEditor from '#lib/components/calendar/EventEditor.svelte';
	import type { CalendarInfo, Occurrence } from '#lib/calendar/types.ts';

	type View = 'day' | 'week' | 'month';

	const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	const HOUR_PX = 48;
	const MAX_VISIBLE_IN_MONTH = 3;

	let view = $state<View>(typeof window !== 'undefined' && window.innerWidth < 720 ? 'day' : 'week');
	let anchor = $state(startOfDay(new Date()));
	let calendars = $state<CalendarInfo[]>([]);
	let addresses = $state<string[]>([]);
	let occurrences = $state<Occurrence[]>([]);
	let loading = $state(true);
	let error = $state('');
	let editor = $state<{ occurrence: Occurrence | null; start: string | null } | null>(null);
	let now = $state(new Date());
	let scroller = $state<HTMLDivElement | null>(null);

	// --- dates, in the viewer's own time zone ---------------------------------

	function startOfDay(date: Date): Date {
		return new Date(date.getFullYear(), date.getMonth(), date.getDate());
	}

	function addDays(date: Date, days: number): Date {
		return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
	}

	/** Weeks start on Sunday. */
	function startOfWeek(date: Date): Date {
		return addDays(startOfDay(date), -date.getDay());
	}

	function sameDay(a: Date, b: Date): boolean {
		return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
	}

	function dateKey(date: Date): string {
		return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
	}

	const range = $derived.by(() => {
		if (view === 'day') return { start: anchor, end: addDays(anchor, 1) };
		if (view === 'week') {
			const start = startOfWeek(anchor);
			return { start, end: addDays(start, 7) };
		}
		const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
		const start = startOfWeek(first);
		return { start, end: addDays(start, 42) };
	});

	const days = $derived.by(() => {
		const list: Date[] = [];
		for (let day = range.start; day < range.end; day = addDays(day, 1)) list.push(day);
		return list;
	});

	const title = $derived.by(() => {
		if (view === 'month') return anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
		if (view === 'day') return anchor.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
		const last = addDays(range.end, -1);
		const from = range.start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
		if (range.start.getMonth() === last.getMonth()) return `${from} – ${last.getDate()}, ${last.getFullYear()}`;
		return `${from} – ${last.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
	});

	function move(step: number) {
		if (view === 'day') anchor = addDays(anchor, step);
		else if (view === 'week') anchor = addDays(anchor, step * 7);
		else anchor = new Date(anchor.getFullYear(), anchor.getMonth() + step, 1);
	}

	// --- loading ------------------------------------------------------------------

	/** One request at a time, so the first visit can't make two calendars. */
	let calendarsLoading: Promise<void> | null = null;
	function loadCalendars(): Promise<void> {
		calendarsLoading ??= (async () => {
			try {
				const res = await fetch(`/api/calendar/calendars?timezone=${encodeURIComponent(browserZone)}`);
				if (!res.ok) throw new Error('calendars');
				const body = await res.json();
				calendars = body.calendars;
				addresses = body.addresses ?? [];
			} finally {
				calendarsLoading = null;
			}
		})();
		return calendarsLoading;
	}

	let requestId = 0;
	async function loadEvents() {
		const id = ++requestId;
		loading = true;
		error = '';
		try {
			if (untrack(() => calendars.length) === 0) await loadCalendars();
			const params = new URLSearchParams({ start: range.start.toISOString(), end: range.end.toISOString() });
			const res = await fetch(`/api/calendar/events?${params}`);
			if (!res.ok) throw new Error('events');
			const body = await res.json();
			if (id === requestId) occurrences = body.occurrences;
		} catch {
			if (id === requestId) error = "Couldn't load your calendar. Try again.";
		} finally {
			if (id === requestId) loading = false;
		}
	}

	$effect(() => {
		void range.start.getTime();
		void range.end.getTime();
		loadEvents();
	});

	$effect(() => {
		const timer = setInterval(() => (now = new Date()), 60_000);
		return () => clearInterval(timer);
	});

	// Start the day at 7:00 rather than midnight.
	$effect(() => {
		if (scroller && view !== 'month') scroller.scrollTop = 7 * HOUR_PX - 8;
	});

	// --- laying out events --------------------------------------------------------

	type Placed = { item: Occurrence; top: number; height: number; column: number; columns: number; startsHere: boolean };

	function allDayOn(day: Date): Occurrence[] {
		const key = dateKey(day);
		return occurrences.filter((item) => item.allDay && item.startLocal.slice(0, 10) <= key && key < item.endLocal.slice(0, 10));
	}

	/** Timed events overlapping a day, placed in side-by-side columns where they overlap. */
	function timedOn(day: Date): Placed[] {
		const dayStart = day.getTime();
		const dayEnd = addDays(day, 1).getTime();
		const segments = occurrences
			.filter((item) => !item.allDay)
			.map((item) => {
				const start = Date.parse(item.start);
				const end = Date.parse(item.end);
				return { item, start: Math.max(start, dayStart), end: Math.min(end, dayEnd), startsHere: start >= dayStart };
			})
			.filter((segment) => segment.end > segment.start)
			.sort((a, b) => a.start - b.start || b.end - a.end);

		const placed: Placed[] = [];
		let cluster: Array<(typeof segments)[number] & { column: number }> = [];
		let clusterEnd = -Infinity;
		const flush = () => {
			const columns = Math.max(1, ...cluster.map((segment) => segment.column + 1));
			for (const segment of cluster) {
				const minutes = (segment.start - dayStart) / 60_000;
				const length = Math.max(20, (segment.end - segment.start) / 60_000);
				placed.push({
					item: segment.item,
					top: (minutes / 60) * HOUR_PX,
					height: (length / 60) * HOUR_PX,
					column: segment.column,
					columns,
					startsHere: segment.startsHere
				});
			}
			cluster = [];
		};
		for (const segment of segments) {
			if (segment.start >= clusterEnd) {
				flush();
				clusterEnd = -Infinity;
			}
			const used = new Set(cluster.filter((other) => other.end > segment.start).map((other) => other.column));
			let column = 0;
			while (used.has(column)) column++;
			cluster.push({ ...segment, column });
			clusterEnd = Math.max(clusterEnd, segment.end);
		}
		flush();
		return placed;
	}

	function monthItems(day: Date): Occurrence[] {
		const dayStart = day.getTime();
		const dayEnd = addDays(day, 1).getTime();
		return [
			...allDayOn(day),
			...occurrences.filter((item) => !item.allDay && Date.parse(item.start) < dayEnd && Date.parse(item.end) > dayStart)
		];
	}

	function timeLabel(item: Occurrence): string {
		return new Date(item.start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
	}

	function hourLabel(hour: number): string {
		return new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, { hour: 'numeric' });
	}

	// --- creating and editing ----------------------------------------------------------

	function openSlot(day: Date, event: MouseEvent) {
		const target = event.currentTarget as HTMLElement;
		const offset = event.clientY - target.getBoundingClientRect().top;
		const minutes = Math.max(0, Math.min(23 * 60 + 30, Math.floor(((offset / HOUR_PX) * 60) / 30) * 30));
		const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
		editor = { occurrence: null, start: `${dateKey(day)}T${time}` };
	}

	function openNew() {
		const base = view === 'day' ? anchor : startOfDay(new Date());
		const hour = Math.min(22, new Date().getHours() + 1);
		editor = { occurrence: null, start: `${dateKey(base)}T${String(hour).padStart(2, '0')}:00` };
	}

	let notice = $state('');
	function done(close: boolean, message?: string) {
		if (close) editor = null;
		notice = message ?? '';
		loadEvents();
	}

	// --- subscribe link -------------------------------------------------------------

	let subscribeOpen = $state(false);
	let subscribeLink = $state<{ link: string; webcal: string } | null>(null);
	let subscribeBusy = $state(false);
	let copied = $state(false);
	const mainCalendar = $derived(calendars.find((calendar) => calendar.isDefault) ?? calendars[0]);

	async function makeLink() {
		if (!mainCalendar) return;
		subscribeBusy = true;
		try {
			const res = await fetch(`/api/calendar/calendars/${mainCalendar.id}/feed`, { method: 'POST' });
			if (res.ok) {
				subscribeLink = await res.json();
				await loadCalendars();
			}
		} finally {
			subscribeBusy = false;
		}
	}

	async function turnOffLink() {
		if (!mainCalendar) return;
		subscribeBusy = true;
		try {
			await fetch(`/api/calendar/calendars/${mainCalendar.id}/feed`, { method: 'DELETE' });
			subscribeLink = null;
			await loadCalendars();
		} finally {
			subscribeBusy = false;
		}
	}

	async function copyLink() {
		if (!subscribeLink) return;
		await navigator.clipboard?.writeText(subscribeLink.link).catch(() => undefined);
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}
</script>

<svelte:head>
	<title>Calendar — CloudMail</title>
</svelte:head>

<div class="calendar-page">
	<header class="toolbar">
		<div class="nav">
			<button type="button" class="btn-ghost" onclick={() => (anchor = startOfDay(new Date()))}>Today</button>
			<button type="button" class="icon-button" aria-label="Previous" onclick={() => move(-1)}>
				<Icon name="arrow-left-s-line" size={20} />
			</button>
			<button type="button" class="icon-button" aria-label="Next" onclick={() => move(1)}>
				<Icon name="arrow-right-s-line" size={20} />
			</button>
			<h1>{title}</h1>
			{#if loading}<span class="loading" aria-live="polite">Loading…</span>{/if}
		</div>
		<div class="nav">
			<div class="views" role="tablist" aria-label="View">
				{#each ['day', 'week', 'month'] as const as option (option)}
					<button type="button" role="tab" aria-selected={view === option} class:active={view === option} onclick={() => (view = option)}>
						{option[0].toUpperCase() + option.slice(1)}
					</button>
				{/each}
			</div>
			<button type="button" class="btn-ghost" onclick={() => (subscribeOpen = !subscribeOpen)} aria-expanded={subscribeOpen}>
				<Icon name="smartphone-line" size={16} /> On your phone
			</button>
			<button type="button" class="btn-primary" onclick={openNew}>
				<Icon name="add-line" size={16} /> New event
			</button>
		</div>
	</header>

	{#if subscribeOpen}
		<section class="subscribe surface-lg">
			<p>
				See this calendar in Apple Calendar, Google Calendar, or Outlook on your phone with a private
				subscribe link. Anyone with the link can see your events, so keep it to yourself. Changes show up
				there within about 15 minutes; for now you add and edit events here.
			</p>
			{#if subscribeLink}
				<div class="link-row">
					<input type="text" readonly value={subscribeLink.link} aria-label="Subscribe link" />
					<button type="button" class="btn-ghost" onclick={copyLink}>{copied ? 'Copied' : 'Copy'}</button>
					<a class="btn-ghost" href={subscribeLink.webcal}>Open in Calendar</a>
				</div>
				<p class="hint">
					This is the only time the link is shown. On an iPhone, tap "Open in Calendar". In Google Calendar on
					the web: Other calendars → + → From URL, and paste it.
				</p>
			{/if}
			<div class="link-row">
				<button type="button" class="btn-ghost" disabled={subscribeBusy || !mainCalendar} onclick={makeLink}>
					{mainCalendar?.hasFeed ? 'Make a new link (turns the old one off)' : 'Make a subscribe link'}
				</button>
				{#if mainCalendar?.hasFeed}
					<button type="button" class="btn-ghost" disabled={subscribeBusy} onclick={turnOffLink}>Turn the link off</button>
				{/if}
			</div>
		</section>
	{/if}

	{#if error}<p class="error" role="alert">{error}</p>{/if}
	{#if notice}<p class="error" role="status">{notice}</p>{/if}

	{#if view === 'month'}
		<div class="month surface-lg">
			{#each days.slice(0, 7) as day (day.getTime())}
				<div class="month-head">{day.toLocaleDateString(undefined, { weekday: 'short' })}</div>
			{/each}
			{#each days as day (day.getTime())}
				{@const items = monthItems(day)}
				<div
					class="month-cell"
					class:outside={day.getMonth() !== anchor.getMonth()}
					class:today={sameDay(day, now)}
					role="button"
					tabindex="0"
					aria-label={`New event on ${day.toLocaleDateString()}`}
					onclick={() => (editor = { occurrence: null, start: `${dateKey(day)}T09:00` })}
					onkeydown={(event) => event.key === 'Enter' && (editor = { occurrence: null, start: `${dateKey(day)}T09:00` })}
				>
					<button
						type="button"
						class="day-number"
						onclick={(event) => {
							event.stopPropagation();
							anchor = day;
							view = 'day';
						}}
					>
						{day.getDate()}
					</button>
					{#each items.slice(0, MAX_VISIBLE_IN_MONTH) as item (`${item.eventId}:${item.occurrence}`)}
						<button
							type="button"
							class="chip color-{item.color}"
							class:all-day={item.allDay}
							onclick={(event) => {
								event.stopPropagation();
								editor = { occurrence: item, start: null };
							}}
						>
							{#if !item.allDay}<span class="chip-time">{timeLabel(item)}</span>{/if}
							{item.title}
						</button>
					{/each}
					{#if items.length > MAX_VISIBLE_IN_MONTH}
						<button
							type="button"
							class="more"
							onclick={(event) => {
								event.stopPropagation();
								anchor = day;
								view = 'day';
							}}
						>
							{items.length - MAX_VISIBLE_IN_MONTH} more
						</button>
					{/if}
				</div>
			{/each}
		</div>
	{:else}
		<div class="grid surface-lg" style="--days: {days.length}">
			<div class="grid-head">
				<div class="gutter"></div>
				{#each days as day (day.getTime())}
					<div class="day-head" class:today={sameDay(day, now)}>
						<span class="weekday">{day.toLocaleDateString(undefined, { weekday: 'short' })}</span>
						<span class="date">{day.getDate()}</span>
					</div>
				{/each}
			</div>
			<div class="all-day-row">
				<div class="gutter label">All day</div>
				{#each days as day (day.getTime())}
					<div
						class="all-day-cell"
						role="button"
						tabindex="0"
						aria-label={`New all-day event on ${day.toLocaleDateString()}`}
						onclick={() => (editor = { occurrence: null, start: dateKey(day) })}
						onkeydown={(event) => event.key === 'Enter' && (editor = { occurrence: null, start: dateKey(day) })}
					>
						{#each allDayOn(day) as item (`${item.eventId}:${item.occurrence}`)}
							<button
								type="button"
								class="chip all-day color-{item.color}"
								onclick={(event) => {
									event.stopPropagation();
									editor = { occurrence: item, start: null };
								}}
							>
								{item.title}
							</button>
						{/each}
					</div>
				{/each}
			</div>
			<div class="scroller" bind:this={scroller}>
				<div class="hours" style="height: {24 * HOUR_PX}px">
					<div class="gutter">
						{#each Array.from({ length: 24 }, (_, hour) => hour) as hour (hour)}
							<span class="hour-label" style="top: {hour * HOUR_PX}px">{hour === 0 ? '' : hourLabel(hour)}</span>
						{/each}
					</div>
					{#each days as day (day.getTime())}
						<div
							class="day-column"
							role="button"
							tabindex="-1"
							aria-label={`New event on ${day.toLocaleDateString()}`}
							onclick={(event) => openSlot(day, event)}
							onkeydown={() => undefined}
						>
							{#each timedOn(day) as placed (`${placed.item.eventId}:${placed.item.occurrence}`)}
								<button
									type="button"
									class="event color-{placed.item.color}"
									class:free={placed.item.transparency === 'free'}
									style="top: {placed.top}px; height: {placed.height - 2}px; left: calc({(placed.column / placed.columns) * 100}% + 2px); width: calc({100 / placed.columns}% - 4px)"
									onclick={(event) => {
										event.stopPropagation();
										editor = { occurrence: placed.item, start: null };
									}}
								>
									<span class="event-title">
										{#if placed.item.recurring}<Icon name="repeat-line" size={11} />{/if}
										{placed.item.title}
									</span>
									{#if placed.height >= 36}
										<span class="event-time">
											{placed.startsHere ? timeLabel(placed.item) : 'continued'}{placed.item.location ? ` · ${placed.item.location}` : ''}
										</span>
									{/if}
								</button>
							{/each}
							{#if sameDay(day, now)}
								<div class="now" style="top: {((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_PX}px"></div>
							{/if}
						</div>
					{/each}
				</div>
			</div>
		</div>
	{/if}
</div>

{#if editor && calendars.length > 0}
	<EventEditor {calendars} {addresses} occurrence={editor.occurrence} start={editor.start} onDone={done} onClose={() => (editor = null)} />
{/if}

<style>
	.calendar-page {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		height: 100%;
		min-height: 0;
		padding: 1rem;
	}

	.toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.nav {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.375rem;
	}

	.nav h1 {
		margin-left: 0.25rem;
		font-size: 1.25rem;
		font-weight: 600;
		letter-spacing: -0.01em;
	}

	.loading,
	.hint {
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.icon-button {
		display: inline-flex;
		padding: 0.25rem;
		border-radius: 0.375rem;
		color: var(--color-text-secondary);
	}

	.icon-button:hover {
		color: var(--color-text);
		background: var(--color-surface-muted);
	}

	.views {
		display: inline-flex;
		padding: 2px;
		border-radius: 0.5rem;
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.views button {
		padding: 0.25rem 0.75rem;
		border-radius: 0.375rem;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.views button.active {
		color: var(--color-text);
		background: var(--color-surface-muted);
	}

	.subscribe {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 1rem;
		border-radius: 0.75rem;
		font-size: 0.875rem;
	}

	.link-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.link-row input {
		flex: 1;
		min-width: 12rem;
		padding: 0.375rem 0.625rem;
		border-radius: 0.5rem;
		font: inherit;
		font-size: 0.8125rem;
		color: var(--color-text);
		background: transparent;
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.error {
		color: var(--color-danger);
		font-size: 0.875rem;
	}

	/* Event colors: the hue on the left edge, a light wash behind. */
	.color-blue { --event: #3b6fd8; }
	.color-green { --event: #2f9e5b; }
	.color-purple { --event: #8250df; }
	.color-orange { --event: #d9822b; }
	.color-red { --event: #d1453b; }
	.color-teal { --event: #1f9aa5; }
	.color-gray { --event: #7a7f87; }

	/* Week and day */
	.grid {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		border-radius: 0.75rem;
		overflow: hidden;
	}

	.grid-head,
	.all-day-row,
	.hours {
		display: grid;
		grid-template-columns: 3.5rem repeat(var(--days), minmax(0, 1fr));
	}

	.grid-head {
		box-shadow: inset 0 -1px 0 var(--color-line);
	}

	.day-head {
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 0.5rem 0;
		font-size: 0.75rem;
		color: var(--color-text-secondary);
	}

	.day-head .date {
		font-size: 1.25rem;
		font-weight: 500;
		color: var(--color-text);
	}

	.day-head.today .date {
		display: inline-grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		border-radius: 9999px;
		color: var(--color-on-accent);
		background: var(--color-accent);
	}

	.all-day-row {
		box-shadow: inset 0 -1px 0 var(--color-line);
	}

	.gutter.label {
		padding: 0.375rem;
		font-size: 0.6875rem;
		color: var(--color-text-secondary);
		text-align: right;
	}

	.all-day-cell {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-height: 1.75rem;
		padding: 2px;
		box-shadow: inset 1px 0 0 var(--color-line);
		cursor: pointer;
	}

	.scroller {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
	}

	.hours {
		position: relative;
	}

	.hours > .gutter {
		position: relative;
	}

	.hour-label {
		position: absolute;
		right: 0.375rem;
		transform: translateY(-50%);
		font-size: 0.6875rem;
		color: var(--color-text-secondary);
	}

	.day-column {
		position: relative;
		cursor: pointer;
		box-shadow: inset 1px 0 0 var(--color-line);
		background-image: repeating-linear-gradient(
			to bottom,
			var(--color-line) 0 1px,
			transparent 1px 48px
		);
	}

	.event {
		position: absolute;
		display: flex;
		flex-direction: column;
		gap: 1px;
		padding: 2px 6px;
		overflow: hidden;
		border-radius: 0.375rem;
		text-align: left;
		font-size: 0.75rem;
		line-height: 1.25;
		color: var(--color-text);
		background: color-mix(in srgb, var(--event) 18%, var(--color-surface));
		box-shadow: inset 3px 0 0 var(--event);
	}

	.event.free {
		background: transparent;
		box-shadow:
			inset 3px 0 0 var(--event),
			inset 0 0 0 1px color-mix(in srgb, var(--event) 40%, transparent);
	}

	.event:hover {
		background: color-mix(in srgb, var(--event) 28%, var(--color-surface));
	}

	.event-title {
		display: flex;
		align-items: center;
		gap: 3px;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.event-time {
		color: var(--color-text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.now {
		position: absolute;
		left: 0;
		right: 0;
		height: 2px;
		background: var(--color-danger);
		pointer-events: none;
	}

	.now::before {
		content: '';
		position: absolute;
		left: -4px;
		top: -4px;
		width: 10px;
		height: 10px;
		border-radius: 9999px;
		background: var(--color-danger);
	}

	/* Month */
	.month {
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
		grid-auto-rows: auto;
		flex: 1;
		border-radius: 0.75rem;
		overflow: hidden;
	}

	.month-head {
		padding: 0.5rem;
		font-size: 0.75rem;
		text-align: center;
		color: var(--color-text-secondary);
		box-shadow: inset 0 -1px 0 var(--color-line);
	}

	.month-cell {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-height: 6.5rem;
		padding: 0.25rem;
		box-shadow:
			inset 1px 0 0 var(--color-line),
			inset 0 -1px 0 var(--color-line);
		cursor: pointer;
	}

	.month-cell.outside {
		background: var(--color-surface-muted);
	}

	.month-cell.outside .day-number {
		color: var(--color-text-secondary);
	}

	.day-number {
		align-self: flex-start;
		min-width: 1.75rem;
		height: 1.75rem;
		border-radius: 9999px;
		font-size: 0.8125rem;
		font-weight: 500;
	}

	.month-cell.today .day-number {
		color: var(--color-on-accent);
		background: var(--color-accent);
	}

	.chip {
		display: block;
		width: 100%;
		padding: 1px 6px;
		overflow: hidden;
		border-radius: 0.25rem;
		font-size: 0.75rem;
		line-height: 1.4;
		text-align: left;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--color-text);
	}

	.chip::before {
		content: '';
		display: inline-block;
		width: 6px;
		height: 6px;
		margin-right: 4px;
		border-radius: 9999px;
		background: var(--event);
		vertical-align: middle;
	}

	.chip.all-day {
		background: color-mix(in srgb, var(--event) 18%, var(--color-surface));
	}

	.chip.all-day::before {
		display: none;
	}

	.chip:hover {
		background: color-mix(in srgb, var(--event) 26%, var(--color-surface));
	}

	.chip-time {
		color: var(--color-text-secondary);
		margin-right: 2px;
	}

	.more {
		align-self: flex-start;
		padding: 0 6px;
		font-size: 0.75rem;
		color: var(--color-text-secondary);
	}

	@media (max-width: 720px) {
		.calendar-page {
			padding: 0.5rem;
		}

		.month-cell {
			min-height: 4.5rem;
		}

		.chip-time {
			display: none;
		}
	}
</style>
