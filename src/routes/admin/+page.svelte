<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import AddressField from '#lib/components/AddressField.svelte';
	import { AI_PROVIDER_INFO, AI_PROVIDERS, type AiProvider } from '#lib/agents/providers.ts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let localPart = $state('');
	let newUserDomainId = $state('');
	let name = $state('');
	let password = $state('');

	$effect(() => {
		if (!newUserDomainId && data.domains[0]) {
			newUserDomainId = data.domains[0].id;
		}
	});
	let userError = $state('');
	let creatingUser = $state(false);

	let connecting = $state<string | null>(null);
	let domainError = $state('');

	const connectable = $derived(data.available.filter((domain) => !domain.connected));

	function addressesFor(domainId: string) {
		return data.addresses.filter((address) => address.domain_id === domainId);
	}

	function userLabel(userId: string | null) {
		if (!userId) return 'Nobody (unrouted mail is held)';
		const match = data.users.find((user) => user.id === userId);
		return match ? `${match.name} (${match.email})` : 'Unknown user';
	}

	async function createUser(event: SubmitEvent) {
		event.preventDefault();
		userError = '';
		creatingUser = true;

		try {
			const res = await fetch('/api/admin/users', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, localPart, domainId: newUserDomainId, password })
			});
			const body = await res.json();
			if (!res.ok) {
				userError = body.error ?? 'Failed to create user';
				return;
			}
			window.location.reload();
		} catch {
			userError = 'Network error';
		} finally {
			creatingUser = false;
		}
	}

	async function connect(domainId: string) {
		connecting = domainId;
		domainError = '';

		try {
			const res = await fetch('/api/domains', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ domainId })
			});
			const body = await res.json();
			if (!res.ok) {
				domainError = body.error ?? 'Could not connect that domain';
				return;
			}
			window.location.reload();
		} catch {
			domainError = 'Network error';
		} finally {
			connecting = null;
		}
	}

	async function updateDomain(domainId: string, patch: Record<string, unknown>) {
		domainError = '';
		const res = await fetch(`/api/domains/${domainId}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(patch)
		});
		const body = await res.json();
		if (!res.ok) {
			domainError = body.error ?? 'Update failed';
			return;
		}
		window.location.reload();
	}

	let aiProvider = $state<AiProvider>('anthropic');
	let aiKey = $state('');
	let aiSaving = $state(false);
	let aiError = $state('');
	let replacingKey = $state(false);

	const savedKey = $derived(data.ai.providers.find((row) => row.provider === aiProvider) ?? null);

	function formatDate(iso: string) {
		return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
	}

	async function saveAiKey(event: SubmitEvent) {
		event.preventDefault();
		aiError = '';
		aiSaving = true;
		try {
			const res = await fetch('/api/admin/ai-provider', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ provider: aiProvider, apiKey: aiKey })
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				aiError = body.message ?? body.error ?? 'Could not save the key';
				return;
			}
			aiKey = '';
			window.location.reload();
		} catch {
			aiError = 'Network error';
		} finally {
			aiSaving = false;
		}
	}

	async function removeAiKey() {
		const label = AI_PROVIDER_INFO[aiProvider].label;
		if (!confirm(`Remove the ${label} key? Agents stop running until a new key is saved.`)) return;
		aiError = '';
		const res = await fetch('/api/admin/ai-provider', {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ provider: aiProvider })
		});
		if (res.ok) window.location.reload();
		else aiError = 'Could not remove the key';
	}

	async function disconnect(domainId: string, domainName: string) {
		if (!confirm(`Stop using ${domainName} in this dashboard? Mail already received is kept.`)) {
			return;
		}

		const res = await fetch(`/api/domains/${domainId}`, { method: 'DELETE' });
		if (res.ok) window.location.reload();
	}
</script>

<svelte:head>
	<title>Admin — CloudMail</title>
</svelte:head>

<div class="admin-page">
	<h1>Admin</h1>

	{#if data.loadError}
		<div class="surface-lg banner">
			<Icon name="error-warning-line" size={16} />
			<span>{data.loadError}</span>
		</div>
	{/if}

	<section class="surface-lg admin-card">
		<h2><Icon name="global-line" size={18} /> Domains</h2>
		<p class="card-hint">
			Connected domains send and receive through {data.providerKind === 'cloudflare'
				? 'Cloudflare Email'
				: 'Resend'}. Catch-all decides who gets mail addressed to an unknown mailbox on that
			domain.
		</p>

		<ul class="domain-list">
			{#each data.domains as domain (domain.id)}
				<li class="domain-item">
					<div class="domain-head">
						<div class="min-w-0">
							<p class="domain-name">{domain.name}</p>
							<p class="domain-sub">
								{addressesFor(domain.id).length} address{addressesFor(domain.id).length === 1
									? ''
									: 'es'}
								{#if domain.region}· {domain.region}{/if}
							</p>
						</div>
						<div class="chips">
							<span class="chip" class:chip-on={domain.sending_enabled}>send</span>
							<span class="chip" class:chip-on={domain.receiving_enabled}>receive</span>
							<span class="chip" class:chip-ok={domain.status === 'verified'}>{domain.status}</span>
						</div>
					</div>

					<div class="domain-controls">
						<label class="control">
							<span class="control-label">Catch-all</span>
							<select
								value={domain.catchall_user_id ?? ''}
								onchange={(event) =>
									updateDomain(domain.id, {
										catchallUserId: (event.currentTarget as HTMLSelectElement).value || null
									})}
							>
								<option value="">Nobody (hold as unrouted)</option>
								{#each data.users as user (user.id)}
									<option value={user.id}>{user.name} — {user.email}</option>
								{/each}
							</select>
						</label>

						<div class="control-actions">
							<button
								type="button"
								class="btn-ghost text-xs"
								onclick={() => updateDomain(domain.id, { refresh: true })}
							>
								<Icon name="refresh-line" size={14} /> Re-sync
							</button>
							<button
								type="button"
								class="btn-ghost text-xs"
								onclick={() => disconnect(domain.id, domain.name)}
							>
								Disconnect
							</button>
						</div>
					</div>

					{#if !domain.receiving_enabled}
						<p class="hint">
							<Icon name="information-line" size={13} />
							Inbound is off for this domain — enable receiving
							{data.providerKind === 'cloudflare'
								? "and point Email Routing's catch-all at this Worker"
								: 'and add the MX record at the provider'}
							to get mail.
						</p>
					{/if}
					{#if domain.catchall_user_id}
						<p class="hint">
							<Icon name="user-received-line" size={13} />
							Unmatched mail goes to {userLabel(domain.catchall_user_id)}.
						</p>
					{/if}
				</li>
			{/each}
		</ul>

		{#if connectable.length > 0}
			<div class="connect-block">
				<p class="connect-title">
					Available in {data.providerKind === 'cloudflare' ? 'Cloudflare Email' : 'Resend'}
				</p>
				<ul class="connect-list">
					{#each connectable as domain (domain.id)}
						<li class="connect-row">
							<div class="min-w-0">
								<p class="domain-name">{domain.name}</p>
								<p class="domain-sub">{domain.status}{#if domain.region} · {domain.region}{/if}</p>
							</div>
							<button
								type="button"
								class="btn-primary text-xs"
								disabled={connecting === domain.id}
								onclick={() => connect(domain.id)}
							>
								{connecting === domain.id ? 'Connecting…' : 'Connect'}
							</button>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if domainError}<p class="error">{domainError}</p>{/if}
	</section>

	<section class="surface-lg admin-card" id="ai">
		<h2><Icon name="key-2-line" size={18} /> AI provider</h2>
		<p class="card-hint">
			Agents on the Staff page run on this workspace's own key, billed to your provider account. The key is
			checked when you save it, stored encrypted, and never shown again.
		</p>

		{#if data.ai.demo}
			<p class="card-hint mt-4">Agents are not part of the demo.</p>
		{:else if !data.ai.encryptionReady}
			<div class="surface-lg banner mt-4">
				<Icon name="information-line" size={16} />
				<span>
					This server can't store keys yet. Whoever deploys it needs to set an encryption secret once:
					<code>openssl rand -base64 32 | wrangler secret put AI_KEY_ENCRYPTION_KEY</code>
				</span>
			</div>
		{:else}
			{#if AI_PROVIDERS.length > 1}
				<select bind:value={aiProvider} class="admin-input mt-4" aria-label="Provider">
					{#each AI_PROVIDERS as provider (provider)}
						<option value={provider}>{AI_PROVIDER_INFO[provider].label}</option>
					{/each}
				</select>
			{/if}

			{#if savedKey && !replacingKey}
				<div class="user-row mt-2">
					<div class="min-w-0 flex-1">
						<p class="user-name">
							{AI_PROVIDER_INFO[savedKey.provider].label} · ••••{savedKey.hint}
						</p>
						<p class="user-email">
							Saved {formatDate(savedKey.updatedAt)}{savedKey.setBy ? ` by ${savedKey.setBy}` : ''}
						</p>
						{#if savedKey.rejectedAt}
							<p class="error">
								{AI_PROVIDER_INFO[savedKey.provider].label} turned this key down on
								{formatDate(savedKey.rejectedAt)}. Agents are waiting until you save a working key.
							</p>
						{/if}
					</div>
					<button type="button" class="btn-ghost" onclick={() => (replacingKey = true)}>Replace</button>
					<button type="button" class="btn-ghost" onclick={removeAiKey}>Remove</button>
				</div>
			{:else}
				<form class="mt-4 space-y-3" onsubmit={saveAiKey}>
					<input
						type="password"
						bind:value={aiKey}
						required
						autocomplete="off"
						spellcheck="false"
						placeholder="{AI_PROVIDER_INFO[aiProvider].label} API key"
						aria-label="{AI_PROVIDER_INFO[aiProvider].label} API key"
						class="admin-input"
					/>
					<p class="card-hint">
						Create one at <a href={AI_PROVIDER_INFO[aiProvider].keysUrl} target="_blank" rel="noreferrer"
							>{new URL(AI_PROVIDER_INFO[aiProvider].keysUrl).host}</a
						>.
					</p>
					<div class="flex gap-2">
						<button type="submit" disabled={aiSaving || !aiKey} class="btn-primary">
							{aiSaving ? 'Checking…' : 'Save key'}
						</button>
						{#if savedKey}
							<button type="button" class="btn-ghost" onclick={() => ((replacingKey = false), (aiKey = ''))}>
								Cancel
							</button>
						{/if}
					</div>
				</form>
			{/if}
			{#if aiError}<p class="error">{aiError}</p>{/if}
		{/if}
	</section>

	<div class="admin-grid">
		<section class="surface-lg admin-card">
			<h2><Icon name="user-add-line" size={18} /> New user</h2>
			<p class="card-hint">
				Their address is also their login — they can sign in and use it straight away.
			</p>
			<form class="mt-4 space-y-3" onsubmit={createUser}>
				<input type="text" bind:value={name} required placeholder="Display name" class="admin-input" />
				<AddressField
					bind:localPart
					bind:domainId={newUserDomainId}
					domains={data.domains}
					placeholder="name"
					label="Address"
				/>
				<input
					type="text"
					bind:value={password}
					required
					minlength="8"
					placeholder="Temporary password"
					class="admin-input"
				/>

				{#if userError}<p class="error">{userError}</p>{/if}

				<button type="submit" disabled={creatingUser} class="btn-primary">
					{creatingUser ? 'Creating…' : 'Create'}
				</button>
			</form>
		</section>

		<section class="surface-lg admin-card">
			<h2><Icon name="group-line" size={18} /> {data.users.length} users</h2>
			<ul class="user-list">
				{#each data.users as user (user.id)}
					<li class="user-row">
						<div class="user-avatar">{(user.name[0] ?? '?').toUpperCase()}</div>
						<div class="min-w-0 flex-1">
							<p class="user-name">{user.name}</p>
							<p class="user-email">
								{data.addresses
									.filter((address) => address.user_id === user.id)
									.map((address) => address.address)
									.join(', ') || user.email}
							</p>
						</div>
						{#if user.is_admin}
							<span class="admin-badge">Admin</span>
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	</div>

	{#if data.unrouted.length > 0}
		<section class="surface-lg admin-card">
			<h2><Icon name="question-mark" size={18} /> Unrouted mail</h2>
			<p class="card-hint">
				Received on a connected domain but no address matched and no catch-all was set.
			</p>
			<ul class="user-list">
				{#each data.unrouted as item (item.id)}
					<li class="user-row">
						<div class="min-w-0 flex-1">
							<p class="user-name">{item.subject || '(no subject)'}</p>
							<p class="user-email">{item.from_addr} → {item.to_addr}</p>
						</div>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</div>

<style>
	.admin-page h1 {
		font-size: 1.375rem;
		font-weight: 600;
		letter-spacing: -0.02em;
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

	.admin-grid {
		display: grid;
		gap: 1.25rem;
		margin-top: 1.25rem;
	}

	@media (min-width: 900px) {
		.admin-grid {
			grid-template-columns: 1fr 1fr;
		}
	}

	.admin-card {
		margin-top: 1.25rem;
		padding: 1.5rem;
	}

	.admin-grid .admin-card {
		margin-top: 0;
	}

	.admin-card h2 {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.9375rem;
		font-weight: 600;
	}

	.card-hint {
		margin-top: 0.375rem;
		font-size: 0.8125rem;
		line-height: 1.5;
		color: var(--color-muted);
	}

	.domain-list {
		margin-top: 1rem;
	}

	.domain-item {
		padding: 1rem 0;
	}

	.domain-item + .domain-item {
		box-shadow: inset 0 1px 0 var(--color-line);
	}

	.domain-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.domain-name {
		font-size: 0.9375rem;
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.domain-sub {
		margin-top: 0.125rem;
		font-size: 0.75rem;
		color: var(--color-muted);
	}

	.chips {
		display: flex;
		gap: 0.3rem;
		flex-shrink: 0;
	}

	.chip {
		padding: 0.0625rem 0.4375rem;
		border-radius: 9999px;
		font-size: 0.6875rem;
		color: var(--color-muted);
		background: var(--color-surface-muted);
	}

	.chip-on {
		color: var(--color-text-secondary);
	}

	.chip-ok {
		color: var(--tone-good-fg);
		background: var(--tone-good-bg);
	}

	.domain-controls {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin-top: 0.875rem;
	}

	.control {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
		flex: 1;
	}

	.control-label {
		font-size: 0.6875rem;
		color: var(--color-muted);
	}

	.control select {
		max-width: 100%;
		padding: 0.4375rem 0.625rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		background: var(--color-surface-muted);
		outline: none;
		cursor: pointer;
	}

	.control-actions {
		display: flex;
		gap: 0.25rem;
	}

	.hint {
		display: flex;
		align-items: flex-start;
		gap: 0.375rem;
		margin-top: 0.5rem;
		font-size: 0.75rem;
		line-height: 1.5;
		color: var(--color-muted);
	}

	.connect-block {
		margin-top: 1.25rem;
		padding-top: 1rem;
		box-shadow: inset 0 1px 0 var(--color-line);
	}

	.connect-title {
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--color-muted);
	}

	.connect-list {
		margin-top: 0.625rem;
	}

	.connect-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.5rem 0;
	}

	.admin-input {
		width: 100%;
		padding: 0.625rem 0.875rem;
		border-radius: 0.625rem;
		font-size: 0.875rem;
		background: var(--color-surface-muted);
		box-shadow: inset 0 0 0 1px var(--color-line);
		outline: none;
	}

	.admin-input:focus {
		box-shadow: inset 0 0 0 1px var(--color-focus-line), 0 0 0 3px var(--color-focus-halo);
	}

	.user-list {
		margin-top: 1rem;
	}

	.user-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem 0;
	}

	.user-row + .user-row {
		box-shadow: inset 0 1px 0 var(--color-line);
	}

	.user-avatar {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 9999px;
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--color-text-secondary);
		background: var(--color-surface-muted);
	}

	.user-name {
		font-size: 0.875rem;
		font-weight: 500;
	}

	.user-email {
		font-size: 0.8125rem;
		color: var(--color-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.admin-badge {
		padding: 0.125rem 0.5rem;
		border-radius: 9999px;
		font-size: 0.6875rem;
		font-weight: 500;
		color: var(--color-text);
		background: var(--color-surface-muted);
	}

	.banner code {
		font-size: 0.75rem;
		word-break: break-all;
	}

	.error {
		margin-top: 0.5rem;
		font-size: 0.8125rem;
		color: var(--color-danger);
	}
</style>
