<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import {
		AUTONOMY_LABELS,
		AUTONOMY_LEVELS,
		CAPABILITIES,
		CAPABILITY_LABELS,
		CAPABILITY_TRAITS,
		type AutonomyLevel,
		type Capability
	} from '$lib/agents/capabilities';
	import type { AgentDefinition } from '$lib/agents/definition';
	import type { AgentStatus } from '$lib/agents/policy';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type Draft = {
		name: string;
		job: string;
		levels: Record<Capability, AutonomyLevel>;
		limits: Record<Capability, string>;
		sendAs: string[];
		recipientKind: 'thread' | 'domains';
		domains: string;
	};

	function blankDraft(): Draft {
		const levels = {} as Record<Capability, AutonomyLevel>;
		const limits = {} as Record<Capability, string>;
		for (const capability of CAPABILITIES) {
			levels[capability] = CAPABILITY_TRAITS[capability].defaultLevel;
			limits[capability] = '';
		}
		return { name: '', job: '', levels, limits, sendAs: [], recipientKind: 'thread', domains: '' };
	}

	function draftFrom(name: string, definition: AgentDefinition): Draft {
		const draft = blankDraft();
		draft.name = name;
		draft.job = definition.job;
		for (const capability of CAPABILITIES) {
			const setting = definition.capabilities[capability];
			draft.levels[capability] = setting?.level ?? 'off';
			draft.limits[capability] = setting?.dailyLimit === undefined ? '' : String(setting.dailyLimit);
		}
		draft.sendAs = [...definition.scope.sendAs];
		if (definition.scope.recipients.kind === 'domains') {
			draft.recipientKind = 'domains';
			draft.domains = definition.scope.recipients.domains.join(', ');
		}
		return draft;
	}

	let draft = $state<Draft>(blankDraft());
	let editingId = $state<string | null>(null);
	/** Send-as addresses the agent had when the form opened, so ones the editor can't grant stay visible and untickable. */
	let grantedSendAs = $state<string[]>([]);
	const sendAsOptions = $derived([...new Set([...data.sendAs, ...grantedSendAs])].sort());
	let formOpen = $state(false);
	let saving = $state(false);
	let formError = $state('');
	let listError = $state('');
	let busy = $state<string | null>(null);

	const anyRunning = $derived(data.agents.some((agent) => agent.status !== 'paused'));

	const FORM_ERRORS: Record<string, string> = {
		name: 'Give the agent a name, up to 80 characters.',
		job: 'Describe the job, up to 8,000 characters.',
		level: 'Pick a setting for every capability.',
		limit: 'Daily limits must be whole numbers from 0 to 10,000.',
		scope: 'Check the send-as addresses and domains.',
		send_as: 'You can only let it send from addresses you could send from yourself.'
	};

	function openHire() {
		draft = blankDraft();
		editingId = null;
		grantedSendAs = [];
		formError = '';
		formOpen = true;
	}

	function openEdit(id: string) {
		const agent = data.agents.find((item) => item.id === id);
		if (!agent) return;
		draft = draftFrom(agent.displayName, agent.definition);
		editingId = id;
		grantedSendAs = [...agent.definition.scope.sendAs];
		formError = '';
		formOpen = true;
	}

	function definitionFromDraft(): AgentDefinition | null {
		const capabilities: AgentDefinition['capabilities'] = {};
		for (const capability of CAPABILITIES) {
			const raw = draft.limits[capability].trim();
			const limit = raw === '' ? undefined : Number(raw);
			if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
				formError = FORM_ERRORS.limit;
				return null;
			}
			capabilities[capability] = { level: draft.levels[capability], ...(limit === undefined ? {} : { dailyLimit: limit }) };
		}
		const domains = draft.domains
			.split(/[\s,]+/)
			.map((domain) => domain.trim())
			.filter(Boolean);
		if (draft.recipientKind === 'domains' && domains.length === 0) {
			formError = 'Add at least one domain, or keep replies to the thread.';
			return null;
		}
		return {
			job: draft.job,
			capabilities,
			scope: {
				sendAs: draft.sendAs,
				recipients: draft.recipientKind === 'domains' ? { kind: 'domains', domains } : { kind: 'thread' }
			}
		};
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		formError = '';
		const definition = definitionFromDraft();
		if (!definition) return;

		saving = true;
		try {
			const res = editingId
				? await fetch(`/api/agents/${editingId}`, {
						method: 'PATCH',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ definition })
					})
				: await fetch('/api/agents', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ name: draft.name, definition })
					});
			const body = await res.json().catch(() => null);
			if (!res.ok) {
				formError =
					res.status === 403
						? 'Only its owner or an admin can change this agent.'
						: (FORM_ERRORS[body?.error] ?? 'Could not save the agent.');
				return;
			}
			window.location.reload();
		} catch {
			formError = 'Network error';
		} finally {
			saving = false;
		}
	}

	async function setStatus(id: string, status: AgentStatus) {
		listError = '';
		busy = id;
		try {
			const res = await fetch(`/api/agents/${id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ status })
			});
			if (!res.ok) {
				listError =
					res.status === 403 ? 'Only its owner or an admin can do that.' : 'Could not change that agent.';
				return;
			}
			window.location.reload();
		} catch {
			listError = 'Network error';
		} finally {
			busy = null;
		}
	}

	async function pauseAll() {
		if (!confirm('Pause every agent? Nothing they propose will run until you resume them.')) return;
		listError = '';
		busy = 'all';
		try {
			const res = await fetch('/api/agents/pause-all', { method: 'POST' });
			if (!res.ok) {
				listError = 'Could not pause the agents.';
				return;
			}
			window.location.reload();
		} catch {
			listError = 'Network error';
		} finally {
			busy = null;
		}
	}

	async function decide(id: string, decision: 'approve' | 'decline') {
		listError = '';
		busy = id;
		try {
			const res = await fetch(`/api/agents/actions/${id}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ decision })
			});
			const body = await res.json().catch(() => null);
			if (!res.ok) {
				listError =
					res.status === 409
						? `That proposal is already ${body?.current ?? 'decided'}.`
						: 'Could not record your decision.';
				if (res.status === 403) listError = 'Only its owner or an admin can approve this.';
				if (res.status !== 409) return;
			}
			window.location.reload();
		} catch {
			listError = 'Network error';
		} finally {
			busy = null;
		}
	}

	function statusLabel(status: AgentStatus, shadowRemaining: number): string {
		if (status === 'shadow') return `Shadow · ${shadowRemaining} left`;
		return status === 'active' ? 'Active' : 'Paused';
	}

	function capabilityName(capability: string): string {
		return capability in CAPABILITY_LABELS ? CAPABILITY_LABELS[capability as Capability].name : capability;
	}

	function enabled(definition: AgentDefinition): string {
		const names = CAPABILITIES.filter((capability) => {
			const level = definition.capabilities[capability]?.level;
			return level && level !== 'off';
		}).map((capability) => CAPABILITY_LABELS[capability].name);
		return names.length ? names.join(', ') : 'Nothing enabled';
	}

	function preview(payload: unknown): string {
		const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
		return text.length > 1500 ? `${text.slice(0, 1500)}…` : text;
	}

	function when(iso: string | null): string {
		return iso ? new Date(iso).toLocaleString() : '';
	}
</script>

<svelte:head>
	<title>Staff — CloudMail</title>
</svelte:head>

<div class="staff-page">
	<div class="page-head">
		<h1>Staff</h1>
		{#if !data.demo}
			<div class="head-actions">
				{#if anyRunning}
					<button type="button" class="btn-ghost" disabled={busy === 'all'} onclick={pauseAll}>
						<Icon name="pause-circle-line" size={16} /> Pause all
					</button>
				{/if}
				<button type="button" class="btn-primary" onclick={openHire}>
					<Icon name="user-add-line" size={16} /> Hire an agent
				</button>
			</div>
		{/if}
	</div>
	<p class="page-hint">
		Agents work your mail alongside you. A new agent starts in shadow mode: it shows you what it would
		do, and nothing leaves your workspace until you let it.
	</p>

	{#if data.demo}
		<div class="surface-lg banner">
			<Icon name="information-line" size={16} />
			<span>Agents aren't part of the demo.</span>
		</div>
	{/if}

	{#if listError}
		<div class="surface-lg banner" role="alert">
			<Icon name="error-warning-line" size={16} />
			<span>{listError}</span>
		</div>
	{/if}

	{#if formOpen}
		<form class="surface-lg card" onsubmit={save}>
			<h2>
				<Icon name={editingId ? 'edit-line' : 'user-add-line'} size={18} />
				{editingId ? `Edit ${draft.name}` : 'Hire an agent'}
			</h2>
			{#if editingId}
				<p class="card-hint">Saving creates a new version. Earlier versions are kept.</p>
			{/if}

			{#if !editingId}
				<label class="field">
					<span>Name</span>
					<input class="text-input" bind:value={draft.name} maxlength="80" required placeholder="Ava" />
				</label>
			{/if}

			<label class="field">
				<span>Job</span>
				<textarea
					class="text-input"
					rows="5"
					bind:value={draft.job}
					maxlength="8000"
					required
					placeholder="Answer demo requests sent to demo@, offer times, and hand anything about pricing to me."
				></textarea>
			</label>

			<fieldset class="group">
				<legend>What it may do</legend>
				<div class="cap-table">
					{#each CAPABILITIES as capability (capability)}
						<div class="cap-row">
							<div class="cap-text">
								<p class="cap-name">{CAPABILITY_LABELS[capability].name}</p>
								<p class="cap-hint">{CAPABILITY_LABELS[capability].hint}</p>
							</div>
							<select
								class="text-input cap-level"
								aria-label="{CAPABILITY_LABELS[capability].name} setting"
								bind:value={draft.levels[capability]}
							>
								{#each AUTONOMY_LEVELS as level (level)}
									<option value={level}>{AUTONOMY_LABELS[level]}</option>
								{/each}
							</select>
							<input
								class="text-input cap-limit"
								inputmode="numeric"
								placeholder="No limit"
								aria-label="{CAPABILITY_LABELS[capability].name} daily limit"
								disabled={draft.levels[capability] === 'off'}
								bind:value={draft.limits[capability]}
							/>
						</div>
					{/each}
				</div>
				<p class="card-hint">The last column is the most times per day it may do that.</p>
			</fieldset>

			<fieldset class="group">
				<legend>Send as</legend>
				{#if sendAsOptions.length === 0}
					<p class="card-hint">You have no addresses it could send from.</p>
				{:else}
					<div class="checks">
						{#each sendAsOptions as address (address)}
							<label class="check">
								<input type="checkbox" value={address} bind:group={draft.sendAs} />
								<span>{address}</span>
								{#if !data.sendAs.includes(address)}
									<span class="item-sub">You can't grant this one any more. Untick it to save.</span>
								{/if}
							</label>
						{/each}
					</div>
					<p class="card-hint">Leave these all unticked and it can't send mail at all.</p>
				{/if}
			</fieldset>

			<fieldset class="group">
				<legend>Who it may email</legend>
				<label class="check">
					<input type="radio" value="thread" bind:group={draft.recipientKind} />
					<span>Only people already on the thread, and you</span>
				</label>
				<label class="check">
					<input type="radio" value="domains" bind:group={draft.recipientKind} />
					<span>Also anyone at these domains</span>
				</label>
				{#if draft.recipientKind === 'domains'}
					<input
						class="text-input"
						bind:value={draft.domains}
						placeholder="customer.com, partner.io"
						aria-label="Domains"
					/>
				{/if}
			</fieldset>

			{#if formError}
				<p class="form-error" role="alert">{formError}</p>
			{/if}

			<div class="form-actions">
				<button type="button" class="btn-ghost" onclick={() => (formOpen = false)}>Cancel</button>
				<button type="submit" class="btn-primary" disabled={saving}>
					{editingId ? 'Save new version' : 'Hire in shadow mode'}
				</button>
			</div>
		</form>
	{/if}

	<section class="surface-lg card">
		<h2><Icon name="checkbox-circle-line" size={18} /> Needs your OK</h2>
		{#if data.queue.length === 0}
			<p class="card-hint">Nothing waiting. Proposals that need your OK show up here.</p>
		{:else}
			<ul class="list">
				{#each data.queue as action (action.id)}
					<li class="item">
						<div class="item-head">
							<p class="item-title">{action.agentName} · {capabilityName(action.capability)}</p>
							{#if action.expiresAt}
								<span class="chip">Expires {when(action.expiresAt)}</span>
							{/if}
						</div>
						{#if action.reason}
							<p class="item-sub">{action.reason}</p>
						{/if}
						<pre class="payload">{preview(action.payload)}</pre>
						<div class="item-actions">
							{#if !action.canApprove}
								<span class="item-sub">Only its owner or an admin can approve this.</span>
							{/if}
							<button
								type="button"
								class="btn-ghost text-xs"
								disabled={busy === action.id}
								onclick={() => decide(action.id, 'decline')}
							>
								Decline
							</button>
							{#if action.canApprove}
								<button
									type="button"
									class="btn-primary text-xs"
									disabled={busy === action.id}
									onclick={() => decide(action.id, 'approve')}
								>
									Approve
								</button>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section class="surface-lg card">
		<h2><Icon name="team-line" size={18} /> Agents</h2>
		{#if data.agents.length === 0}
			<p class="card-hint">No agents yet. Hire one to give it a job.</p>
		{:else}
			<ul class="list">
				{#each data.agents as agent (agent.id)}
					<li class="item">
						<div class="item-head">
							<div class="min-w-0">
								<p class="item-title">{agent.displayName}</p>
								<p class="item-sub">
									Version {agent.versionNumber}{agent.runtime === 'external' ? ' · External' : ''}{agent.queued
										? ` · ${agent.queued} waiting for you`
										: ''}
								</p>
							</div>
							<span
								class="chip"
								class:chip-good={agent.status === 'active'}
								class:chip-warn={agent.status === 'paused'}
							>
								{statusLabel(agent.status, agent.shadowRemaining)}
							</span>
						</div>
						<p class="job">{agent.definition.job}</p>
						<p class="item-sub">{enabled(agent.definition)}</p>
						<div class="item-actions">
							{#if agent.canManage}
								<button type="button" class="btn-ghost text-xs" onclick={() => openEdit(agent.id)}>
									Edit
								</button>
							{/if}
							{#if agent.status === 'paused' && agent.canManage}
								<button
									type="button"
									class="btn-ghost text-xs"
									disabled={busy === agent.id}
									onclick={() => setStatus(agent.id, 'shadow')}
								>
									Resume in shadow mode
								</button>
								<button
									type="button"
									class="btn-ghost text-xs"
									disabled={busy === agent.id}
									onclick={() => setStatus(agent.id, 'active')}
								>
									Resume
								</button>
							{:else if agent.status !== 'paused'}
								{#if agent.status === 'shadow' && agent.canManage}
									<button
										type="button"
										class="btn-ghost text-xs"
										disabled={busy === agent.id}
										onclick={() => setStatus(agent.id, 'active')}
									>
										End shadow mode
									</button>
								{/if}
								<button
									type="button"
									class="btn-ghost text-xs"
									disabled={busy === agent.id}
									onclick={() => setStatus(agent.id, 'paused')}
								>
									<Icon name="pause-line" size={14} /> Pause
								</button>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>

<style>
	.page-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 0.75rem;
	}

	.page-head h1 {
		font-size: 1.375rem;
		font-weight: 600;
		letter-spacing: -0.02em;
	}

	.head-actions {
		display: flex;
		gap: 0.5rem;
	}

	.page-hint,
	.card-hint {
		margin-top: 0.375rem;
		font-size: 0.8125rem;
		line-height: 1.5;
		color: var(--color-muted);
	}

	.banner {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 1rem;
		padding: 0.875rem 1.125rem;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		box-shadow: 0 0 0 1px var(--tone-notice-line), var(--shadow-sm);
	}

	.card {
		margin-top: 1.25rem;
		padding: 1.5rem;
	}

	.card h2 {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.9375rem;
		font-weight: 600;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin-top: 1rem;
	}

	.field > span,
	.group legend {
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.text-input {
		width: 100%;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--color-line);
		border-radius: 0.5rem;
		background: var(--color-bg);
		color: var(--color-text);
		font-size: 0.875rem;
	}

	.text-input:disabled {
		opacity: 0.5;
	}

	textarea.text-input {
		resize: vertical;
		line-height: 1.5;
	}

	.group {
		margin-top: 1.25rem;
	}

	.group legend {
		margin-bottom: 0.5rem;
	}

	.cap-row {
		display: grid;
		grid-template-columns: 1fr 9.5rem 6rem;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0;
	}

	.cap-row + .cap-row {
		box-shadow: inset 0 1px 0 var(--color-line);
	}

	@media (max-width: 560px) {
		.cap-row {
			grid-template-columns: 1fr 1fr;
		}

		.cap-text {
			grid-column: 1 / -1;
		}
	}

	.cap-name {
		font-size: 0.875rem;
	}

	.cap-hint {
		font-size: 0.75rem;
		color: var(--color-muted);
	}

	.checks {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.check {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.375rem;
		font-size: 0.875rem;
	}

	.form-error {
		margin-top: 1rem;
		font-size: 0.8125rem;
		color: var(--tone-bad-fg, var(--color-text));
	}

	.form-actions,
	.item-actions {
		display: flex;
		justify-content: flex-end;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 1rem;
	}

	.item-actions {
		margin-top: 0.75rem;
	}

	.list {
		margin-top: 0.75rem;
	}

	.item {
		padding: 1rem 0;
	}

	.item + .item {
		box-shadow: inset 0 1px 0 var(--color-line);
	}

	.item-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.item-title {
		font-size: 0.9375rem;
		font-weight: 500;
	}

	.item-sub {
		margin-top: 0.125rem;
		font-size: 0.75rem;
		color: var(--color-muted);
	}

	.job {
		margin-top: 0.5rem;
		font-size: 0.8125rem;
		line-height: 1.5;
		color: var(--color-text-secondary);
		white-space: pre-wrap;
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.payload {
		margin-top: 0.5rem;
		padding: 0.75rem;
		max-height: 14rem;
		overflow: auto;
		border-radius: 0.5rem;
		background: var(--color-surface-muted);
		font-size: 0.75rem;
		line-height: 1.5;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.chip {
		flex-shrink: 0;
		padding: 0.0625rem 0.5rem;
		border-radius: 9999px;
		font-size: 0.6875rem;
		color: var(--color-muted);
		background: var(--color-surface-muted);
	}

	.chip-good {
		color: var(--tone-good-fg);
		background: var(--tone-good-bg);
	}

	.chip-warn {
		color: var(--color-text-secondary);
		box-shadow: 0 0 0 1px var(--tone-notice-line);
	}
</style>
