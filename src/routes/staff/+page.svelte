<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import {
		AUTONOMY_LABELS,
		AUTONOMY_LEVELS,
		CAPABILITIES,
		CAPABILITY_LABELS,
		CAPABILITY_TRAITS,
		type AutonomyLevel,
		type Capability
	} from '#lib/agents/capabilities.ts';
	import {
		AGENT_MODEL_LABELS,
		AGENT_MODELS,
		DEFAULT_MONTHLY_BUDGET_CENTS,
		type AgentDefinition,
		type AgentModel
	} from '#lib/agents/definition.ts';
	import type { AgentStatus } from '#lib/agents/policy.ts';
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
		watch: string[];
		model: AgentModel;
		/** Dollars, as typed. */
		budget: string;
	};

	function blankDraft(): Draft {
		const levels = {} as Record<Capability, AutonomyLevel>;
		const limits = {} as Record<Capability, string>;
		for (const capability of CAPABILITIES) {
			levels[capability] = CAPABILITY_TRAITS[capability].defaultLevel;
			limits[capability] = '';
		}
		return {
			name: '',
			job: '',
			levels,
			limits,
			sendAs: [],
			recipientKind: 'thread',
			domains: '',
			watch: [],
			model: AGENT_MODELS[0],
			budget: String(DEFAULT_MONTHLY_BUDGET_CENTS / 100)
		};
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
		draft.watch = [...definition.triggers.watch];
		draft.model = definition.model;
		draft.budget = String(definition.monthlyBudgetCents / 100);
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
	/** Same rule for watched addresses. */
	let grantedWatch = $state<string[]>([]);
	const watchOptions = $derived([...new Set([...data.sendAs, ...grantedWatch])].sort());
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
		send_as: 'You can only let it send from addresses you could send from yourself.',
		watch: 'You can only let it watch addresses you could send from yourself.',
		trigger: 'Check the addresses it watches.',
		model: 'Pick a model.',
		budget: 'The monthly budget must be from $0 to $1,000.'
	};

	function openHire() {
		draft = blankDraft();
		editingId = null;
		grantedSendAs = [];
		grantedWatch = [];
		formError = '';
		formOpen = true;
	}

	function openEdit(id: string) {
		const agent = data.agents.find((item) => item.id === id);
		if (!agent) return;
		draft = draftFrom(agent.displayName, agent.definition);
		editingId = id;
		grantedSendAs = [...agent.definition.scope.sendAs];
		grantedWatch = [...agent.definition.triggers.watch];
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
		const dollars = Number(draft.budget.trim().replace(/^\$/, ''));
		if (!draft.budget.trim() || !Number.isFinite(dollars) || dollars < 0 || dollars > 1000) {
			formError = FORM_ERRORS.budget;
			return null;
		}
		return {
			job: draft.job,
			capabilities,
			scope: {
				sendAs: draft.sendAs,
				recipients: draft.recipientKind === 'domains' ? { kind: 'domains', domains } : { kind: 'thread' }
			},
			triggers: { watch: draft.watch },
			model: draft.model,
			monthlyBudgetCents: Math.round(dollars * 100)
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

	async function rate(id: string, current: 'up' | 'down' | null, feedback: 'up' | 'down') {
		listError = '';
		busy = id;
		try {
			const res = await fetch(`/api/agents/actions/${id}/feedback`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				// Clicking the same thumb again takes it back.
				body: JSON.stringify({ feedback: current === feedback ? null : feedback })
			});
			if (!res.ok) {
				listError = 'Could not save that.';
				return;
			}
			window.location.reload();
		} catch {
			listError = 'Network error';
		} finally {
			busy = null;
		}
	}

	function dollars(micros: number): string {
		return `$${(micros / 1_000_000).toFixed(2)}`;
	}

	const RUN_OUTCOMES: Record<string, string> = {
		proposed: 'Made proposals',
		nothing_to_do: 'Nothing to do',
		already_proposed: 'Made proposals',
		turn_limit: 'Stopped after 4 steps',
		max_tokens: 'Answer was cut off',
		refused: 'The model declined',
		paused: 'Skipped: paused',
		budget_reached: 'Skipped: monthly budget reached, so it was paused',
		no_tools: 'Skipped: no actions switched on',
		email_gone: 'Skipped: the message was deleted',
		agent_gone: 'Skipped: agent removed',
		api_key_invalid: 'Failed: the API key was rejected',
		gave_up: 'Failed after 3 tries'
	};

	function runLabel(run: (typeof data.runs)[number]): string {
		if (run.status === 'pending') return 'Waiting to run';
		if (run.status === 'running') return 'Running';
		if (run.outcome && RUN_OUTCOMES[run.outcome]) return RUN_OUTCOMES[run.outcome];
		return run.status === 'failed' ? `Failed (${run.outcome ?? 'error'})` : (run.outcome ?? run.status);
	}

	function payloadText(payload: unknown): string {
		if (!payload || typeof payload !== 'object') return preview(payload);
		const raw = payload as Record<string, unknown>;
		if (typeof raw.body === 'string') {
			const to = Array.isArray(raw.to) && raw.to.length ? `To: ${raw.to.join(', ')}\n` : '';
			return preview(`${to}${raw.body}`);
		}
		if (typeof raw.note === 'string') return preview(raw.note);
		if (typeof raw.action === 'string') {
			return raw.action === 'add_label' ? `Add the label "${raw.label}"` : raw.action.replace('_', ' ');
		}
		return preview(payload);
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

	{#if !data.demo && !data.agentsEnabled}
		<div class="surface-lg banner">
			<Icon name="information-line" size={16} />
			<span>
				Agents aren't connected to an AI model yet, so they don't run. Add an Anthropic API key to turn
				them on. Anything they're asked to do waits until then.
			</span>
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
				<legend>Wakes up for</legend>
				{#if watchOptions.length === 0}
					<p class="card-hint">You have no addresses it could watch. You can still ask it on any thread.</p>
				{:else}
					<div class="checks">
						{#each watchOptions as address (address)}
							<label class="check">
								<input type="checkbox" value={address} bind:group={draft.watch} />
								<span>New mail to {address}</span>
								{#if !data.sendAs.includes(address)}
									<span class="item-sub">You can't grant this one any more. Untick it to save.</span>
								{/if}
							</label>
						{/each}
					</div>
					<p class="card-hint">You can also ask it for help on any thread with "Ask an agent".</p>
				{/if}
			</fieldset>

			<fieldset class="group">
				<legend>Model and budget</legend>
				<div class="model-row">
					<label class="field">
						<span>Model</span>
						<select class="text-input" bind:value={draft.model}>
							{#each AGENT_MODELS as model (model)}
								<option value={model}>{AGENT_MODEL_LABELS[model]}</option>
							{/each}
						</select>
					</label>
					<label class="field">
						<span>Monthly budget (USD)</span>
						<input class="text-input" inputmode="decimal" bind:value={draft.budget} aria-label="Monthly budget in dollars" />
					</label>
				</div>
				<p class="card-hint">Reaching the budget pauses the agent until next month or until you raise it.</p>
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
		<h2><Icon name="eye-line" size={18} /> Would have done</h2>
		{#if data.shadow.length === 0}
			<p class="card-hint">
				Nothing yet. When an agent in shadow mode proposes something, it shows here instead of happening.
			</p>
		{:else}
			<p class="card-hint">Nothing here was carried out. Thumbs up or down tells you, over time, whether to trust it more.</p>
			<ul class="list">
				{#each data.shadow as action (action.id)}
					<li class="item">
						<div class="item-head">
							<p class="item-title">{action.agentName} · {capabilityName(action.capability)}</p>
							<span class="chip">{action.status === 'shadowed' ? 'Shadow' : 'Allowed, not run yet'}</span>
						</div>
						{#if action.reason}
							<p class="item-sub">{action.reason}</p>
						{/if}
						<pre class="payload">{payloadText(action.payload)}</pre>
						<div class="item-actions">
							<span class="item-sub">{when(action.createdAt)}</span>
							<button
								type="button"
								class="btn-ghost text-xs"
								class:chosen={action.feedback === 'up'}
								aria-pressed={action.feedback === 'up'}
								aria-label="Good call"
								disabled={busy === action.id}
								onclick={() => rate(action.id, action.feedback, 'up')}
							>
								<Icon name="thumb-up-line" size={14} />
							</button>
							<button
								type="button"
								class="btn-ghost text-xs"
								class:chosen={action.feedback === 'down'}
								aria-pressed={action.feedback === 'down'}
								aria-label="Wrong call"
								disabled={busy === action.id}
								onclick={() => rate(action.id, action.feedback, 'down')}
							>
								<Icon name="thumb-down-line" size={14} />
							</button>
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	{#if data.runs.length > 0}
		<section class="surface-lg card">
			<h2><Icon name="history-line" size={18} /> Activity</h2>
			<ul class="list">
				{#each data.runs as run (run.id)}
					<li class="item">
						<div class="item-head">
							<div class="min-w-0">
								<p class="item-title">
									{run.agentName} · {run.triggerKind === 'ask' ? 'Asked on' : 'New mail'}
									{#if run.subject}
										<a href="/mail/{run.emailId}">{run.subject}</a>
									{/if}
								</p>
								<p class="item-sub">{runLabel(run)} · {when(run.createdAt)}{run.costMicros ? ` · ${dollars(run.costMicros)}` : ''}</p>
							</div>
						</div>
						{#if run.summary}
							<p class="item-sub">{run.summary}</p>
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}

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
						<p class="item-sub">
							{agent.definition.triggers.watch.length
								? `Wakes up for mail to ${agent.definition.triggers.watch.join(', ')}`
								: 'Wakes up only when asked'} · {AGENT_MODEL_LABELS[agent.definition.model]} · {dollars(
								data.spend[agent.id] ?? 0
							)} of {dollars(agent.definition.monthlyBudgetCents * 10_000)} this month
						</p>
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
	.model-row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
		gap: 0.75rem;
	}

	.chosen {
		color: var(--tone-good-fg);
		background: var(--tone-good-bg);
	}

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
