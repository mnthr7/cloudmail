<script lang="ts">
	import { authLines, senderDetails } from '#lib/security/headers.ts';
	import type { MessageSecurity } from '#lib/security/security-result.ts';
	import { showToast } from '#lib/toast.ts';

	let {
		emailId,
		security,
		fallback
	}: {
		emailId: string;
		security: MessageSecurity | null;
		/** What the message row knows, for mail that arrived before headers were kept. */
		fallback: { from: string; to: string; replyTo: string | null; messageId: string | null };
	} = $props();

	let rawHeaders = $state<string | null>(null);
	let loading = $state(true);
	let failed = $state(false);
	let showRaw = $state(false);

	$effect(() => {
		const id = emailId;
		loading = true;
		failed = false;
		// Never show one message's headers under another's details.
		rawHeaders = null;
		showRaw = false;
		fetch(`/api/mail/${encodeURIComponent(id)}/headers`)
			.then(async (res) => {
				if (!res.ok) throw new Error(String(res.status));
				const body = (await res.json()) as { rawHeaders?: string | null };
				if (id === emailId) rawHeaders = typeof body.rawHeaders === 'string' ? body.rawHeaders : null;
			})
			.catch(() => {
				if (id === emailId) failed = true;
			})
			.finally(() => {
				if (id === emailId) loading = false;
			});
	});

	const details = $derived(senderDetails(rawHeaders, security?.authText ?? null));
	const checks = $derived(authLines(security?.auth));

	type Row = { label: string; value: string; hint?: string; flag?: boolean };
	const rows = $derived.by((): Row[] => {
		const d = details;
		const list: Row[] = [
			{ label: 'From', value: d.from ?? fallback.from, hint: 'What the sender wrote. Anyone can write anything here.' }
		];
		if (d.sender) list.push({ label: 'Sender', value: d.sender });
		if (d.returnPath) list.push({ label: 'Return-Path', value: d.returnPath, hint: 'Where bounces go: usually the account that really sent it.' });
		const replyTo = d.replyTo ?? fallback.replyTo;
		if (replyTo) list.push({ label: 'Reply-To', value: replyTo, hint: 'Where your reply would go.' });
		list.push({ label: 'To', value: d.to ?? fallback.to });
		if (d.cc) list.push({ label: 'Cc', value: d.cc });
		if (d.date) list.push({ label: 'Date', value: d.date });
		if (d.mailedBy) {
			list.push({
				label: 'Mailed by',
				value: d.mailedBy.domain,
				hint: d.mailedBy.checked ? 'Checked when it arrived.' : 'Claimed by the sender, not checked.'
			});
		}
		if (d.signedBy.length) {
			list.push({
				label: 'Signed by',
				value: d.signedBy.map((fact) => `${fact.domain}${fact.checked ? '' : ' (not verified)'}`).join(', ')
			});
		}
		if (d.origin) list.push({ label: 'First server', value: d.origin, hint: `Passed through ${d.hops} server${d.hops === 1 ? '' : 's'}.` });
		const messageId = d.messageId ?? fallback.messageId;
		if (messageId) list.push({ label: 'Message-ID', value: messageId });
		return list;
	});

	async function copyHeaders() {
		if (!rawHeaders) return;
		try {
			await navigator.clipboard.writeText(rawHeaders);
			showToast('Headers copied');
		} catch {
			showToast("Couldn't copy", { kind: 'error' });
		}
	}
</script>

<section class="details" aria-label="Message details">
	{#if details.mismatch}
		<p class="mismatch">{details.mismatch}</p>
	{/if}

	<dl class="rows">
		{#each rows as row (row.label)}
			<dt>{row.label}</dt>
			<dd>
				<span class="value">{row.value}</span>
				{#if row.hint}<span class="hint">{row.hint}</span>{/if}
			</dd>
		{/each}
	</dl>

	{#if checks.length}
		<p class="section">Checks when it arrived</p>
		<ul class="checks">
			{#each checks as check (check.method)}
				<li>
					<span class="chip" class:good={check.ok === true} class:bad={check.ok === false}>
						{check.method} {check.result}
					</span>
					<span class="hint">{check.note}</span>
				</li>
			{/each}
		</ul>
	{/if}

	{#if loading}
		<p class="hint">Loading headers…</p>
	{:else if failed}
		<p class="hint">Couldn't load the original headers.</p>
	{:else if rawHeaders}
		<div class="raw-actions">
			<button type="button" class="link" aria-expanded={showRaw} onclick={() => (showRaw = !showRaw)}>
				{showRaw ? 'Hide original headers' : 'Show original headers'}
			</button>
			<button type="button" class="link" onclick={copyHeaders}>Copy</button>
		</div>
		{#if showRaw}
			<pre class="raw">{rawHeaders}</pre>
		{/if}
	{:else}
		<p class="hint">The original headers weren't kept for this message. Mail that arrives from now on keeps them.</p>
	{/if}
</section>

<style>
	.details {
		margin-top: 0.625rem;
		padding-top: 0.625rem;
		border-top: 1px solid var(--color-line);
		font-size: 0.8125rem;
		line-height: 1.5;
		color: var(--color-text);
	}

	.mismatch {
		margin: 0 0 0.5rem;
		font-weight: 600;
	}

	.rows {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		gap: 0.25rem 0.875rem;
		margin: 0;
	}

	dt {
		color: var(--color-text-secondary);
		white-space: nowrap;
	}

	dd {
		margin: 0;
		min-width: 0;
	}

	.value {
		overflow-wrap: anywhere;
	}

	.hint {
		display: block;
		font-size: 0.75rem;
		color: var(--color-text-secondary);
	}

	.section {
		margin: 0.75rem 0 0.25rem;
		font-weight: 600;
	}

	.checks {
		display: grid;
		gap: 0.25rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.checks li {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.checks .hint {
		display: inline;
	}

	.chip {
		padding: 0 0.5rem;
		border-radius: 9999px;
		font-size: 0.75rem;
		font-weight: 600;
		background: var(--color-surface-muted);
		color: var(--color-text-secondary);
		white-space: nowrap;
	}

	.chip.good {
		background: var(--tone-good-bg);
		color: var(--tone-good-fg);
	}

	.chip.bad {
		background: var(--tone-bad-bg);
		color: var(--tone-bad-fg);
	}

	.raw-actions {
		display: flex;
		gap: 1rem;
		margin-top: 0.75rem;
	}

	.link {
		color: var(--color-link);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.raw {
		margin: 0.5rem 0 0;
		max-height: 24rem;
		overflow: auto;
		padding: 0.625rem 0.75rem;
		border-radius: 0.375rem;
		background: var(--color-surface);
		box-shadow: inset 0 0 0 1px var(--color-line);
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.6875rem;
		line-height: 1.5;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>
