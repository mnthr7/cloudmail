<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import { explainDetail, type ActivityState, type ThreadActivity } from '#lib/agents/activity.ts';

	/**
	 * What agents did, want to do, or noted on this thread (A12), and the
	 * take-over switch (A13). Only the mailbox owner sees any of it.
	 */
	let {
		activity,
		emailId,
		hasAgents = false,
		agentNames = []
	}: {
		activity: ThreadActivity | null;
		/** Any message in the thread, for the take-over and note routes. */
		emailId: string | null;
		/** Agents exist in the workspace, so taking over means something. */
		hasAgents?: boolean;
		/** Agents this user can @mention, for the hint. */
		agentNames?: string[];
	} = $props();

	let noteText = $state('');
	let noteBusy = $state(false);
	let noteMessage = $state('');
	/** Keep the note to yourself even though an agent is working the thread. */
	let justForMe = $state(false);
	let noteBox = $state<HTMLTextAreaElement | null>(null);

	/** The agent working this thread: the last one that did or noted something here. */
	const workingAgent = $derived.by(() => {
		for (const item of [...items].reverse()) {
			const name = item.kind === 'action' ? item.agentName : item.kind === 'note' && !item.byHuman ? item.agentName : null;
			if (name && agentNames.includes(name)) return name;
		}
		return null;
	});
	/** Agents the note names, longest names first so "@Sam Billing" isn't "@Sam". */
	const named = $derived(
		[...agentNames]
			.sort((a, b) => b.length - a.length)
			.filter((name) => new RegExp(`(^|[^\\w@])@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\w)`, 'i').test(noteText))
	);
	const goesTo = $derived(named.length ? named : !justForMe && workingAgent ? [workingAgent] : []);

	// The @ picker: open while the word before the caret starts with @.
	let picker = $state<{ query: string; start: number } | null>(null);
	let pickIndex = $state(0);
	const choices = $derived(
		picker ? agentNames.filter((name) => name.toLowerCase().startsWith(picker!.query.toLowerCase())).slice(0, 6) : []
	);

	function updatePicker() {
		if (!noteBox) return;
		const caret = noteBox.selectionStart ?? noteText.length;
		const match = noteText.slice(0, caret).match(/(^|[^\w@])@(\w*)$/);
		picker = match && agentNames.length ? { query: match[2], start: caret - match[2].length - 1 } : null;
		pickIndex = 0;
	}

	async function pick(name: string) {
		if (!picker || !noteBox) return;
		const caret = noteBox.selectionStart ?? noteText.length;
		const insert = `@${name} `;
		noteText = noteText.slice(0, picker.start) + insert + noteText.slice(caret);
		const at = picker.start + insert.length;
		picker = null;
		await Promise.resolve();
		noteBox.focus();
		noteBox.setSelectionRange(at, at);
	}

	function noteKeydown(event: KeyboardEvent) {
		if (picker && choices.length) {
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault();
				pickIndex = (pickIndex + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length;
				return;
			}
			if (event.key === 'Enter' || event.key === 'Tab') {
				event.preventDefault();
				void pick(choices[pickIndex]);
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				picker = null;
				return;
			}
		}
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			(event.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
		}
	}

	const MENTION_ERRORS: Record<string, string> = {
		not_allowed: "isn't yours to direct",
		full: 'already remembers 50 facts; remove some on the Staff page',
		fact: 'can only remember a fact up to 300 characters',
		paused: 'is paused',
		request: 'needs a shorter note'
	};

	async function saveNote(event: SubmitEvent) {
		event.preventDefault();
		if (!emailId || noteBusy || !noteText.trim()) return;
		noteBusy = true;
		noteMessage = '';
		error = '';
		try {
			const res = await fetch(`/api/mail/${emailId}/notes`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ body: noteText, private: justForMe })
			});
			const body = await res.json().catch(() => null);
			if (!res.ok || !body?.activity) {
				error = 'Could not save the note.';
				return;
			}
			override = body.activity;
			noteText = '';
			justForMe = false;
			picker = null;
			const mentions = (body.mentions ?? []) as Array<{ agent: string; outcome: string; error?: string }>;
			noteMessage = mentions
				.map((mention) =>
					mention.outcome === 'asked'
						? `${mention.agent} is on it now.`
						: mention.outcome === 'remembered'
							? `${mention.agent} will remember that.`
							: `${mention.agent} ${MENTION_ERRORS[mention.error ?? ''] ?? "couldn't take it"}.`
				)
				.join(' ');
		} catch {
			error = 'Network error';
		} finally {
			noteBusy = false;
		}
	}

	let override = $state<ThreadActivity | null>(null);
	let busy = $state(false);
	let error = $state('');
	let expanded = $state(false);

	const current = $derived(override ?? activity);
	const items = $derived(current?.items ?? []);
	const takenOver = $derived(current?.takenOver ?? false);
	// Newest few unless opened: notes and alerts matter most, so they're always shown.
	const VISIBLE = 4;
	const shown = $derived(expanded ? items : items.slice(-VISIBLE));

	$effect(() => {
		// A different thread was loaded.
		void activity;
		override = null;
		expanded = false;
	});

	async function toggleTakeOver() {
		if (!emailId || busy) return;
		busy = true;
		error = '';
		try {
			const res = await fetch(`/api/mail/${emailId}/take-over`, { method: takenOver ? 'DELETE' : 'POST' });
			const body = await res.json().catch(() => null);
			if (!res.ok || !body?.activity) {
				error = 'Could not change that. Try again.';
				return;
			}
			override = body.activity;
		} catch {
			error = 'Network error';
		} finally {
			busy = false;
		}
	}

	const STATE_TEXT: Record<ActivityState, string> = {
		waiting: 'Waiting for your OK',
		done: 'Done',
		shadow: 'Would have done (shadow mode)',
		declined: 'Declined',
		expired: 'Expired',
		refused: 'Refused',
		failed: "Couldn't be done",
		stopped: 'Stopped'
	};

	const STATE_ICON: Record<ActivityState, string> = {
		waiting: 'time-line',
		done: 'checkbox-circle-line',
		shadow: 'eye-line',
		declined: 'close-circle-line',
		expired: 'time-line',
		refused: 'forbid-line',
		failed: 'error-warning-line',
		stopped: 'error-warning-line'
	};

	function when(at: string): string {
		const date = new Date(at);
		return Number.isNaN(date.getTime())
			? ''
			: date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
	}
</script>

{#if items.length > 0 || (hasAgents && emailId)}
	<section class="activity" aria-label="Agent activity">
		<header class="activity-head">
			<Icon name="robot-2-line" size={16} />
			<span class="title">Agents</span>
			{#if takenOver}
				<span class="pill">You've taken over</span>
			{/if}
			{#if emailId && (hasAgents || takenOver)}
				<button type="button" class="btn-ghost take-over" disabled={busy} onclick={toggleTakeOver}>
					{takenOver ? 'Let agents work on this' : 'Take over'}
				</button>
			{/if}
		</header>
		{#if takenOver}
			<p class="hint">Agents won't act on this thread on their own. You can still ask one for help.</p>
		{/if}
		{#if error}
			<p class="error" role="alert">{error}</p>
		{/if}

		{#if items.length > VISIBLE && !expanded}
			<button type="button" class="more" onclick={() => (expanded = true)}>
				Show all {items.length}
			</button>
		{/if}

		<ol class="items">
			{#each shown as item, index (item.kind === 'takeover' ? `takeover-${index}` : item.id)}
				{#if item.kind === 'action'}
					<li class="item state-{item.state}">
						<Icon name={STATE_ICON[item.state]} size={15} />
						<div class="body">
							<p class="line">
								<strong>{item.agentName}</strong>
								<span>{item.what}</span>
								<span class="state">· {STATE_TEXT[item.state]}</span>
								{#if item.decidedBy && (item.state === 'done' || item.state === 'declined' || item.state === 'failed' || item.state === 'stopped')}
									<span class="by">· {item.state === 'declined' ? 'declined' : 'approved'} by {item.decidedBy}</span>
								{:else if item.trigger === 'ask'}
									<span class="by">· you asked</span>
								{:else if item.trigger === 'mail' && item.state === 'done'}
									<span class="by">· on its own</span>
								{/if}
							</p>
							{#if explainDetail(item.state, item.detail)}
								<p class="detail">Because {explainDetail(item.state, item.detail)}.</p>
							{/if}
							{#if item.reason}
								<p class="reason">{item.reason}</p>
							{/if}
						</div>
						<time datetime={item.at}>{when(item.at)}</time>
					</li>
				{:else if item.kind === 'note' || item.kind === 'alert'}
					<li class="item note" class:alert={item.kind === 'alert'} class:mine={item.byHuman}>
						<Icon name={item.kind === 'alert' ? 'error-warning-line' : 'sticky-note-line'} size={15} />
						<div class="body">
							<p class="line">
								<strong>{item.agentName ?? (item.byHuman ? 'You' : 'Agent')}</strong>
								<span>{item.kind === 'alert' ? 'stopped itself' : item.byHuman ? 'wrote a note' : 'left a note'}</span>
							</p>
							<p class="note-text">{item.body}</p>
						</div>
						<time datetime={item.at}>{when(item.at)}</time>
					</li>
				{:else if item.kind === 'takeover'}
					<li class="item">
						<Icon name="user-shared-line" size={15} />
						<div class="body">
							<p class="line"><strong>{item.by ?? 'You'}</strong> <span>took this thread over</span></p>
						</div>
						<time datetime={item.at}>{when(item.at)}</time>
					</li>
				{/if}
			{/each}
		</ol>

		{#if emailId}
			<form class="note-form" onsubmit={saveNote}>
				<div class="note-box">
					<textarea
						bind:this={noteBox}
						bind:value={noteText}
						oninput={updatePicker}
						onclick={updatePicker}
						onkeydown={noteKeydown}
						onblur={() => setTimeout(() => (picker = null), 150)}
						rows="2"
						maxlength="2000"
						placeholder={workingAgent && !justForMe
							? `Tell ${workingAgent} what to do, e.g. "Move it to Thursday at 2". Type @ to pick another agent.`
							: agentNames.length
								? `Private note. Type @ to hand this to an agent; "@${agentNames[0]} remember: …" saves a fact.`
								: 'Private note, only you see it.'}
						aria-label="Private note"
						aria-autocomplete="list"
						aria-controls="mention-list"
					></textarea>
					{#if picker && choices.length}
						<ul class="mentions" id="mention-list" role="listbox" aria-label="Agents">
							{#each choices as name, index (name)}
								<li role="option" aria-selected={index === pickIndex}>
									<button
										type="button"
										class:active={index === pickIndex}
										onmousedown={(event) => {
											event.preventDefault();
											void pick(name);
										}}
									>
										<Icon name="robot-2-line" size={14} />
										{name}
									</button>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
				<button type="submit" class="btn-ghost" disabled={noteBusy || !noteText.trim()}>
					{goesTo.length ? `Send to ${goesTo.join(' and ')}` : 'Save note'}
				</button>
			</form>
			<p class="hint note-route">
				{#if goesTo.length}
					<Icon name="flashlight-line" size={13} />
					{goesTo.join(' and ')} {goesTo.length === 1 ? 'starts' : 'start'} on this as soon as you send it.
				{:else}
					Only you see this note.
				{/if}
				{#if workingAgent && !named.length}
					<label class="just-me">
						<input type="checkbox" bind:checked={justForMe} />
						Just a note for me
					</label>
				{/if}
			</p>
			{#if noteMessage}<p class="hint" role="status">{noteMessage}</p>{/if}
		{/if}
	</section>
{/if}

<style>
	.activity {
		margin-top: 1.5rem;
		padding-top: 1.25rem;
		box-shadow: inset 0 1px 0 var(--color-line);
		font-size: 0.8125rem;
	}

	.activity-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.875rem;
	}

	.title {
		font-weight: 600;
	}

	.pill {
		padding: 0.125rem 0.5rem;
		border-radius: 9999px;
		font-size: 0.75rem;
		background: var(--color-surface-muted);
		color: var(--color-text-secondary);
	}

	.take-over {
		margin-left: auto;
		font-size: 0.8125rem;
	}

	.hint,
	.error {
		margin-top: 0.375rem;
		color: var(--color-text-secondary);
	}

	.error {
		color: var(--color-danger);
	}

	.more {
		margin-top: 0.5rem;
		color: var(--color-text-secondary);
		text-decoration: underline;
	}

	.items {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-top: 0.625rem;
		list-style: none;
		padding: 0;
	}

	.item {
		display: grid;
		grid-template-columns: auto 1fr auto;
		gap: 0.5rem;
		align-items: start;
		color: var(--color-text-secondary);
	}

	.item :global(i) {
		margin-top: 0.125rem;
	}

	.body {
		min-width: 0;
	}

	.line {
		color: var(--color-text);
		overflow-wrap: anywhere;
	}

	.state,
	.by {
		color: var(--color-text-secondary);
	}

	.state-done :global(i) {
		color: var(--color-text);
	}

	.state-failed :global(i),
	.state-stopped :global(i),
	.alert :global(i) {
		color: var(--color-danger);
	}

	.detail,
	.reason {
		margin-top: 0.125rem;
	}

	.note-text {
		margin-top: 0.25rem;
		padding: 0.5rem 0.75rem;
		border-radius: 0.5rem;
		background: var(--color-surface-muted);
		color: var(--color-text);
		white-space: pre-line;
	}

	.alert .note-text {
		box-shadow: inset 2px 0 0 var(--color-danger);
	}

	.mine .note-text {
		background: transparent;
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.note-form {
		display: flex;
		gap: 0.5rem;
		align-items: flex-end;
		margin-top: 0.75rem;
	}

	.note-box {
		position: relative;
		flex: 1;
		min-width: 0;
		display: flex;
	}

	.mentions {
		position: absolute;
		left: 0.5rem;
		bottom: calc(100% + 0.25rem);
		z-index: 20;
		min-width: 11rem;
		margin: 0;
		padding: 0.25rem;
		list-style: none;
		border-radius: 0.5rem;
		background: var(--color-surface, var(--color-bg));
		box-shadow:
			0 0 0 1px var(--color-line),
			0 8px 24px rgb(0 0 0 / 0.12);
	}

	.mentions button {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.375rem 0.5rem;
		border-radius: 0.375rem;
		font: inherit;
		text-align: left;
		color: var(--color-text);
	}

	.mentions button.active,
	.mentions button:hover {
		background: var(--color-surface-muted);
	}

	.note-route {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.375rem;
	}

	.just-me {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		margin-left: auto;
		cursor: pointer;
	}

	.note-form textarea {
		flex: 1;
		min-width: 0;
		padding: 0.5rem 0.625rem;
		border-radius: 0.5rem;
		font: inherit;
		color: var(--color-text);
		background: transparent;
		box-shadow: inset 0 0 0 1px var(--color-line);
		resize: vertical;
	}

	time {
		font-size: 0.75rem;
		white-space: nowrap;
	}
</style>
