<script lang="ts">
	import Icon from './Icon.svelte';
	import AttachmentList from './AttachmentList.svelte';
	import DeliveryStatus from './DeliveryStatus.svelte';
	import EmailBody from './EmailBody.svelte';
	import InviteCard from './calendar/InviteCard.svelte';
	import { untrack } from 'svelte';
	import { showToast } from '#lib/toast.ts';
	import { formatFullDate, formatRelativeDate } from '#lib/utils/date.ts';
	import { splitQuotedText } from '#lib/utils/quotes.ts';
	import { isMarkdownAttachment } from '#lib/utils/attachments.ts';
	import { resolveMessageBody } from '#lib/utils/markdown.ts';
	import { senderWarning } from '#lib/security/sender.ts';
	import { parseSecurity } from '#lib/security/phishing.ts';
	import type { ThreadMessage } from '#lib/types.ts';

	let {
		message,
		expanded = false,
		onToggle,
		trustedAddresses = []
	}: {
		message: ThreadMessage;
		expanded?: boolean;
		onToggle: () => void;
		/** Lowercased bare addresses whose remote images may load. */
		trustedAddresses?: string[];
	} = $props();

	const outbound = $derived(message.direction === 'outbound');
	const sender = $derived(outbound ? 'me' : message.from_addr);
	const security = $derived(outbound ? null : parseSecurity(message.security_json));
	const nameWarning = $derived.by(() => {
		if (outbound) return null;
		// The phishing banner already says it.
		if (security?.verdict && security.reasons.some((reason) => reason.code === 'name_mismatch')) return null;
		const name = message.from_name?.trim();
		return senderWarning(name ? `${name} <${message.from_addr}>` : message.from_addr);
	});
	const initial = $derived((message.from_addr[0] ?? '?').toUpperCase());

	/** Text-only messages get the same treatment as HTML ones. */
	const text = $derived(splitQuotedText(message.body_text ?? ''));
	const display = $derived(resolveMessageBody(message));
	const hasMarkdownAttachment = $derived(message.attachments.some(isMarkdownAttachment));

	/** One-line teaser for the collapsed state — the reply, not its quotes. */
	const snippet = $derived(text.body.replace(/\s+/g, ' ').trim().slice(0, 140));

	let quoteOpen = $state(false);
	/** Set when an HTML body rendered to nothing — show the text instead. */
	let htmlBlank = $state(false);
	/** Remote image URLs were removed from the copy shown in the frame. */
	let imagesHeld = $state(false);

	/** Address inside angle brackets, otherwise the trimmed From, then lowercased. */
	function bareFromAddress(fromHeader: string): string {
		const trimmed = fromHeader.trim();
		const open = trimmed.indexOf('<');
		const close = open === -1 ? -1 : trimmed.indexOf('>', open + 1);
		if (open !== -1 && close > open) return trimmed.slice(open + 1, close).trim().toLowerCase();
		return trimmed.toLowerCase();
	}

	const fromHeader = $derived(message.from_addr);
	const senderAddress = $derived(bareFromAddress(fromHeader));
	// Captured once per message. "Load images" is this viewing only and must stay put.
	let allowImages = $state(
		untrack(() => trustedAddresses.includes(bareFromAddress(message.from_addr)))
	);

	async function trustSender() {
		try {
			const res = await fetch('/api/image-senders', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ address: senderAddress })
			});
			const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
			if (!res.ok) {
				const text = typeof body?.error === 'string' ? body.error : 'Could not save this sender';
				showToast(text, { kind: 'error' });
				return;
			}
			allowImages = true;
		} catch {
			showToast('Could not save this sender', { kind: 'error' });
		}
	}
	const fallbackText = $derived(
		(message.body_text ?? '').trim() ||
			(message.body_html ?? '')
				.replace(/<(head|style|script|title)[\s>][\s\S]*?<\/\1\s*>/gi, '')
				.replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, '\n')
				.replace(/<[^>]+>/g, '')
				.replace(/&nbsp;/g, ' ')
				.replace(/&amp;/g, '&')
				.replace(/&lt;/g, '<')
				.replace(/&gt;/g, '>')
				.replace(/\n{3,}/g, '\n\n')
				.trim()
	);

	$effect(() => {
		void message.id;
		htmlBlank = false;
	});

	function toggleQuote() {
		quoteOpen = !quoteOpen;
	}

	let unsubscribing = $state(false);

	async function unsubscribe() {
		if (unsubscribing) return;
		unsubscribing = true;
		try {
			const res = await fetch(`/api/mail/${message.id}/unsubscribe`, { method: 'POST' });
			const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
			if (!res.ok) {
				const text =
					typeof body?.error === 'string' && body.error ? body.error : 'Unsubscribe failed';
				showToast(text, { kind: 'error' });
				return;
			}
			showToast('Unsubscribed');
		} catch {
			showToast('Unsubscribe failed', { kind: 'error' });
		} finally {
			unsubscribing = false;
		}
	}
</script>

{#snippet quoteFold(quoted: string)}
	{#if quoted}
		<button
			type="button"
			class="quote-toggle"
			aria-expanded={quoteOpen}
			aria-label={quoteOpen ? 'Hide quoted text' : 'Show quoted text'}
			onclick={toggleQuote}
		>
			···
		</button>
		{#if quoteOpen}
			<p class="whitespace-pre-wrap quoted">{quoted}</p>
		{/if}
	{/if}
{/snippet}

<article class="message" class:collapsed={!expanded}>
	{#if expanded}
		{#if security?.verdict}
			<div class="phishing-banner" class:severe={security.verdict === 'phishing'} role="alert">
				<p class="phishing-title">
					<Icon name={security.verdict === 'phishing' ? 'spam-2-line' : 'error-warning-line'} size={16} />
					{security.verdict === 'phishing'
						? "This looks like phishing. Don't click links, open attachments, or send money or passwords."
						: 'Be careful with this message.'}
				</p>
				<ul>
					{#each security.reasons as reason (reason.code)}
						<li>{reason.text}</li>
					{/each}
				</ul>
			</div>
		{/if}
		{#if nameWarning}
			<p class="sender-banner">{nameWarning}</p>
		{/if}
		<header class="head">
			<div class="avatar" class:self={outbound}>{outbound ? 'me' : initial}</div>

			<button type="button" class="who" onclick={onToggle}>
				<p class="name">
					{sender}
					<span class="direction">to {message.to_addr}</span>
				</p>
				<p class="when">{formatFullDate(message.created_at)}</p>
			</button>

			{#if outbound}
				<DeliveryStatus status={message.status} detail={message.status_detail} />
			{/if}

			{#if message.list_unsubscribe?.trim()}
				<button
					type="button"
					class="unsubscribe"
					disabled={unsubscribing}
					onclick={unsubscribe}
				>
					Unsubscribe
				</button>
			{/if}
		</header>

		{#if message.invite}
			<InviteCard invite={message.invite} />
		{/if}
		<div class="body mail-body">
			{#if imagesHeld && !allowImages}
				<p class="image-hold">
					Images from the sender are hidden.
					<button type="button" onclick={() => (allowImages = true)}>Load images</button>
					<button type="button" onclick={trustSender}>Always load images from this sender</button>
				</p>
			{/if}
			{#if display.kind === 'html' && htmlBlank}
				{#if fallbackText}
					<p class="whitespace-pre-wrap">{fallbackText}</p>
				{:else}
					<p class="empty">This message has no visible content.</p>
				{/if}
			{:else if display.kind === 'html'}
				<EmailBody
					html={display.html}
					allowImages={allowImages}
					{fromHeader}
					onHeld={(held) => (imagesHeld = held)}
					onBlank={() => (htmlBlank = true)}
				/>
			{:else if display.kind === 'markdown'}
				<EmailBody
					html={display.html}
					rich={false}
					foldQuotes={false}
					allowImages={allowImages}
					{fromHeader}
					onHeld={(held) => (imagesHeld = held)}
				/>
				{@render quoteFold(display.quoted)}
			{:else if display.kind === 'text'}
				<p class="whitespace-pre-wrap">{display.body}</p>
				{@render quoteFold(display.quoted)}
			{:else if !hasMarkdownAttachment}
				<p class="empty">Empty message</p>
			{/if}
		</div>

		<AttachmentList emailId={message.id} attachments={message.attachments} compact />

		{#if message.status === 'bounced' || message.status === 'failed'}
			<p class="failure">
				<Icon name="error-warning-line" size={13} />
				{message.status_detail ?? "This message didn't reach the recipient."}
			</p>
		{/if}
	{:else}
		<button type="button" class="summary" onclick={onToggle}>
			<span class="avatar small" class:self={outbound}>{outbound ? 'me' : initial}</span>
			<span class="name">{sender}</span>
			<span class="snippet">{snippet}</span>
			{#if message.attachments.length > 0}
				<Icon name="attachment-2" size={13} />
			{/if}
			<span class="when">{formatRelativeDate(message.created_at)}</span>
		</button>
	{/if}
</article>

<style>
	.message {
		padding: 1.5rem 0;
		box-shadow: inset 0 -1px 0 var(--color-line);
	}

	.message:last-child {
		box-shadow: none;
		padding-bottom: 0;
	}

	.collapsed {
		padding: 0.5rem 0;
	}

	.sender-banner {
		margin: 0 0 0.75rem;
		padding: 0.625rem 0.875rem;
		font-size: 0.8125rem;
		line-height: 1.5;
		color: var(--color-text);
		background: var(--tone-warn-bg);
		border-radius: 0.5rem;
	}

.phishing-banner {
		margin: 0 0 0.75rem;
		padding: 0.625rem 0.875rem;
		font-size: 0.8125rem;
		line-height: 1.5;
		color: var(--color-text);
		background: var(--tone-warn-bg);
		border-radius: 0.5rem;
	}

	.phishing-banner.severe {
		box-shadow: inset 3px 0 0 var(--color-danger);
	}

	.phishing-title {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		font-weight: 600;
	}

	.phishing-banner.severe .phishing-title :global(i) {
		color: var(--color-danger);
	}

	.phishing-banner ul {
		margin: 0.25rem 0 0 1.5rem;
		padding: 0;
		list-style: disc;
	}

	.head {
		display: flex;
		align-items: center;
		gap: 0.875rem;
	}

	.avatar {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 50%;
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--color-on-accent);
		background: var(--color-link);
	}

	.avatar.self {
		color: var(--color-text);
		background: var(--color-surface-hover);
	}

	.avatar.small {
		width: 2rem;
		height: 2rem;
		font-size: 0.75rem;
	}

	.who {
		flex: 1;
		min-width: 0;
		text-align: left;
	}

	.unsubscribe {
		flex-shrink: 0;
		margin-left: auto;
		padding: 0.25rem 0.625rem;
		border-radius: 9999px;
		font-size: 0.75rem;
		color: var(--color-text-secondary);
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.unsubscribe:hover:not(:disabled) {
		color: var(--color-text);
		background: var(--color-surface-hover);
	}

	.unsubscribe:disabled {
		opacity: 0.6;
	}

	.name {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--color-text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.direction {
		margin-left: 0.5rem;
		font-weight: 400;
		color: var(--color-text-secondary);
	}

	.when {
		margin-top: 0.25rem;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		white-space: nowrap;
	}

	.body {
		margin-top: 1.25rem;
		font-size: 0.875rem;
		line-height: 1.6;
	}

	.image-hold {
		margin: 0 0 1rem;
		padding: 0.625rem 0.875rem;
		font-size: 0.8125rem;
		line-height: 1.5;
		color: var(--color-text);
		background: var(--tone-warn-bg);
		border-radius: 0.5rem;
	}

	.image-hold button {
		margin-left: 0.625rem;
		color: var(--color-link);
		font-size: inherit;
		text-decoration: underline;
		text-underline-offset: 0.12em;
	}

	.empty {
		font-style: italic;
		color: var(--color-text-secondary);
	}

	.failure {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		margin-top: 1rem;
		padding: 0.75rem 1rem;
		font-size: 0.8125rem;
		line-height: 1.5;
		color: var(--color-danger);
		background: var(--tone-bad-bg);
		border-radius: 0.5rem;
	}

	/* --- collapsed row --- */

	.summary {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
		padding: 0.875rem 0;
		color: var(--color-text-secondary);
		box-shadow: inset 0 -1px 0 var(--color-line);
		text-align: left;
		border-radius: 0.5rem;
		transition: background 0.15s;
	}

	.summary:hover {
		color: var(--color-text);
		background: var(--color-surface-muted);
	}

	.summary .name {
		flex-shrink: 0;
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--color-text);
	}

	.snippet {
		flex: 1;
		min-width: 0;
		font-size: 0.875rem;
		color: var(--color-text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.summary .when {
		margin-top: 0;
		flex-shrink: 0;
		font-size: 0.8125rem;
	}

	.quoted {
		margin-top: 0.75rem;
		padding-left: 1rem;
		color: var(--color-text-secondary);
		box-shadow: inset 3px 0 0 var(--color-line);
	}

	.quote-toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		margin: 0.75rem 0;
		padding: 0.25rem 0.625rem;
		border-radius: 1rem;
		font-size: 0.875rem;
		line-height: 1.4;
		letter-spacing: 0.05em;
		color: var(--color-text-secondary);
		background: var(--color-surface-muted);
		cursor: pointer;
		transition: background 0.15s;
	}

	.quote-toggle:hover {
		background: var(--color-surface-hover);
	}
</style>
