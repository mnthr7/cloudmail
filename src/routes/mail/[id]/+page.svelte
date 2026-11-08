<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import Icon from '#lib/components/Icon.svelte';
	import RichTextEditor from '#lib/components/RichTextEditor.svelte';
	import AttachmentPicker from '#lib/components/AttachmentPicker.svelte';
	import FromAddressSelect from '#lib/components/FromAddressSelect.svelte';
	import ThreadMessage from '#lib/components/ThreadMessage.svelte';
	import OrganizeMenu from '#lib/components/OrganizeMenu.svelte';
	import AskAgentForm from '#lib/components/AskAgentForm.svelte';
	import { showToast } from '#lib/toast.ts';
	import { htmlToPlainText, isHtmlEmpty } from '#lib/utils/html.ts';
	import {
		defaultReplyFromKey,
		matchThreadReplyFrom,
		replyFromOptions
	} from '#lib/reply-from.ts';
	import type { OutboundAttachmentInput } from '#lib/types.ts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let replyHtml = $state('');
	let replyAttachments = $state<OutboundAttachmentInput[]>([]);
	let replyOpen = $state(false);
	let sending = $state(false);
	let error = $state('');

	let askOpen = $state(false);

	const messages = $derived(data.messages);
	const latest = $derived(messages[messages.length - 1]);
	const starred = $derived(messages.some((message) => message.is_starred));

	const replyFrom = $derived(
		matchThreadReplyFrom(messages, data.addresses, data.domains, data.user?.id ?? '')
	);
	const fromOptions = $derived(
		replyFromOptions(data.addresses, replyFrom.preferred, replyFrom.also)
	);
	const defaultFromKey = $derived(defaultReplyFromKey(data.addresses, replyFrom.preferred));
	let chosenFromKey = $state('');
	const fromKey = $derived(chosenFromKey || defaultFromKey);

	$effect(() => {
		void latest?.id;
		chosenFromKey = '';
	});

	const backHref = $derived(
		data.trashed
			? '/trash'
			: data.spam
				? '/spam'
				: latest?.direction === 'outbound'
					? '/sent'
					: '/inbox'
	);

	/**
	 * Which messages are open: the newest one, whichever message was linked to,
	 * and anything the reader clicks.
	 */
	let opened = $state(new Set<string>());

	$effect(() => {
		const initial = new Set<string>();
		if (data.focusId) initial.add(data.focusId);
		const last = data.messages[data.messages.length - 1];
		if (last) initial.add(last.id);
		opened = initial;
	});

	function toggleMessage(id: string) {
		const next = new Set(opened);
		if (next.has(id) && next.size > 1) next.delete(id);
		else next.add(id);
		opened = next;
	}

	function expandAll() {
		opened = new Set(messages.map((message) => message.id));
	}

	const collapsedCount = $derived(messages.filter((message) => !opened.has(message.id)).length);

	/** Flags apply to the conversation, not to the message that opened it. */
	async function patch(body: Record<string, boolean>, id = latest?.id): Promise<boolean> {
		if (!id) return false;
		try {
			const res = await fetch(`/api/mail/${id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			return res.ok;
		} catch {
			return false;
		}
	}

	async function toggleStar() {
		if (!(await patch({ isStarred: !starred }))) {
			showToast("Couldn't update the star.", { kind: 'error' });
		}
		await invalidateAll();
	}

	async function markUnread() {
		if (!(await patch({ isRead: false }))) {
			showToast("Couldn't mark as unread.", { kind: 'error' });
			return;
		}
		await goto(backHref, { invalidateAll: true });
		showToast('Marked as unread');
	}

	async function reportSpam() {
		const id = latest?.id;
		if (!id) return;
		if (!(await patch({ spam: true }, id))) {
			showToast("Couldn't mark as spam. The message is still here.", { kind: 'error' });
			return;
		}
		await goto(backHref, { invalidateAll: true });
		showToast('Marked as spam', {
			actionLabel: 'Undo',
			onAction: async () => {
				if (!(await patch({ spam: false }, id))) {
					showToast("Couldn't undo. Find it in Spam.", { kind: 'error' });
				}
				await invalidateAll();
			}
		});
	}

	async function notSpam() {
		const id = latest?.id;
		if (!id) return;
		if (!(await patch({ spam: false }, id))) {
			showToast("Couldn't move it out of spam.", { kind: 'error' });
			return;
		}
		await goto(latest?.direction === 'outbound' ? '/sent' : '/inbox', { invalidateAll: true });
		showToast('Removed from spam');
	}

	async function trash() {
		const id = latest?.id;
		if (!id) return;
		if (!(await patch({ trashed: true }, id))) {
			showToast("Couldn't move to trash. The message is still here.", { kind: 'error' });
			return;
		}
		await goto(backHref, { invalidateAll: true });
		showToast('Moved to trash', {
			actionLabel: 'Undo',
			onAction: async () => {
				if (!(await patch({ trashed: false }, id))) {
					showToast("Couldn't undo. Find it in Trash.", { kind: 'error' });
				}
				await invalidateAll();
			}
		});
	}

	async function restore() {
		await patch({ trashed: false });
		await goto('/inbox', { invalidateAll: true });
	}

	async function destroy() {
		if (!latest) return;
		await fetch(`/api/mail/${latest.id}`, { method: 'DELETE' });
		goto('/trash');
	}

	/** Replies continue from the newest message, so the chain stays intact. */
	async function sendReply(event: SubmitEvent) {
		event.preventDefault();
		if (!latest || isHtmlEmpty(replyHtml)) return;

		sending = true;
		error = '';

		try {
			const selected = fromOptions.find((option) => option.key === fromKey);
			const res = await fetch(`/api/mail/${latest.id}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					fromAddressId: selected?.addressId ?? undefined,
					fromAddress: selected?.address,
					html: replyHtml,
					text: htmlToPlainText(replyHtml),
					attachments: replyAttachments
				})
			});
			const body = await res.json();
			if (!res.ok) {
				error = body.error ?? 'Failed to send';
				return;
			}

			replyHtml = '';
			replyAttachments = [];
			replyOpen = false;
			// The sent reply is now part of this conversation.
			await invalidateAll();
		} catch {
			error = 'Network error';
		} finally {
			sending = false;
		}
	}
</script>

<svelte:head>
	<title>{data.subject} — CloudMail</title>
</svelte:head>

<div class="mail-page">
	<header class="mail-toolbar">
		<a href={backHref} class="btn-ghost" aria-label="Back" data-kb="close">
			<Icon name="arrow-left-line" size={18} />
		</a>

		<div class="toolbar-actions">
			<button
				type="button"
				class="icon-btn"
				class:starred
				aria-label={starred ? 'Remove star' : 'Add star'}
				onclick={toggleStar}
				data-kb="star-thread"
			>
				<Icon name={starred ? 'star-fill' : 'star-line'} size={16} />
			</button>

			{#if data.trashed}
				<button type="button" class="icon-btn" aria-label="Restore" onclick={restore}>
					<Icon name="arrow-go-back-line" size={16} />
				</button>
				<button
					type="button"
					class="icon-btn danger"
					aria-label="Delete permanently"
					onclick={destroy}
				>
					<Icon name="delete-bin-2-line" size={16} />
				</button>
			{:else if data.spam}
				<button
					type="button"
					class="icon-btn"
					aria-label="Not spam"
					onclick={notSpam}
					data-kb="spam-thread"
				>
					<Icon name="mail-check-line" size={16} />
				</button>
				<button
					type="button"
					class="icon-btn"
					aria-label="Move to trash"
					onclick={trash}
					data-kb="trash-thread"
				>
					<Icon name="delete-bin-line" size={16} />
				</button>
			{:else}
				<button type="button" class="icon-btn" aria-label="Mark as unread" onclick={markUnread}>
					<Icon name="mail-line" size={16} />
				</button>
				<button
					type="button"
					class="icon-btn"
					aria-label="Mark as spam"
					onclick={reportSpam}
					data-kb="spam-thread"
				>
					<Icon name="spam-2-line" size={16} />
				</button>
				<button
					type="button"
					class="icon-btn"
					aria-label="Move to trash"
					onclick={trash}
					data-kb="trash-thread"
				>
					<Icon name="delete-bin-line" size={16} />
				</button>
			{/if}

			{#if latest}
				<OrganizeMenu
					ids={[latest.id]}
					inInbox={data.inInbox}
					muted={data.isMuted}
					important={data.isImportant}
					category={data.category}
					labels={data.labels}
					align="right"
				/>
			{/if}

			{#if data.agents.length > 0}
				<button type="button" class="btn-ghost" onclick={() => (askOpen = !askOpen)}>
					<Icon name="robot-2-line" size={16} />
					Ask an agent
				</button>
			{/if}

			<button
				type="button"
				class="btn-primary"
				onclick={() => (replyOpen = !replyOpen)}
				data-kb={replyOpen ? undefined : 'reply'}
			>
				<Icon name="reply-line" size={16} />
				{replyOpen ? 'Close' : 'Reply'}
				{#if !replyOpen}<kbd class="kb-hint">r</kbd>{/if}
			</button>
		</div>
	</header>

	<article class="surface-lg mail-card">
		<div class="subject-row">
			<h1>{data.subject}</h1>
			{#if messages.length > 1}
				<span class="thread-count">{messages.length} messages</span>
			{/if}
		</div>

		{#if latest && data.labels.length > 0}
			<div class="mail-labels">
				<OrganizeMenu ids={[latest.id]} labels={data.labels} showMenu={false} showChips />
			</div>
		{/if}

		{#if collapsedCount > 0}
			<button type="button" class="expand-all" onclick={expandAll} data-kb="expand">
				Expand all {messages.length} messages
			</button>
		{/if}

		<div class="thread">
			{#each messages as message (message.id)}
				<ThreadMessage
					{message}
					trustedAddresses={data.trustedAddresses}
					expanded={opened.has(message.id)}
					onToggle={() => toggleMessage(message.id)}
				/>
			{/each}
		</div>

		{#if askOpen && latest && data.agents.length > 0}
			<AskAgentForm agents={data.agents} emailId={latest.id} onClose={() => (askOpen = false)} />
		{/if}

		{#if replyOpen}
			<form class="reply-section" onsubmit={sendReply}>
				<p class="reply-to">
					Replying to
					<strong>
						{latest?.direction === 'inbound' ? latest.from_addr : latest?.to_addr}
					</strong>
				</p>

				<FromAddressSelect
					options={fromOptions}
					value={fromKey}
					onchange={(key) => (chosenFromKey = key)}
				/>

				<div class="reply-footer">
					<AttachmentPicker bind:attachments={replyAttachments} />
					<div class="reply-actions">
						<button type="button" class="btn-ghost" onclick={() => (replyOpen = false)}>
							Cancel
						</button>
						<button type="submit" class="btn-primary" disabled={sending}>
							<Icon name="send-plane-2-fill" size={16} />
							{sending ? 'Sending…' : 'Send'}
						</button>
					</div>
				</div>

				{#if error}
					<p class="reply-status">{error}</p>
				{/if}

				<RichTextEditor bind:html={replyHtml} embedded minHeight={160} placeholder="Reply…" />
			</form>
		{:else}
			<button type="button" class="reply-prompt" onclick={() => (replyOpen = true)}>
				<Icon name="reply-line" size={15} />
				Reply
			</button>
		{/if}
	</article>
</div>

<style>
	.mail-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 1.25rem;
	}

	.toolbar-actions {
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}

	.toolbar-actions :global(.icon-btn.starred) {
		color: var(--color-star);
	}

	.toolbar-actions :global(.icon-btn.danger:hover) {
		color: var(--color-danger);
	}

	.mail-card {
		padding: 1.75rem;
	}

	.mail-card h1 {
		font-size: 1.25rem;
		font-weight: 600;
		letter-spacing: -0.02em;
		line-height: 1.35;
	}

	.subject-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
		padding-bottom: 1rem;
		box-shadow: inset 0 -1px 0 var(--color-line);
	}

	.mail-labels {
		margin-top: 0.75rem;
	}

	.thread-count {
		flex-shrink: 0;
		font-size: 0.75rem;
		color: var(--color-muted);
		white-space: nowrap;
	}

	.expand-all {
		margin-top: 0.875rem;
		font-size: 0.75rem;
		color: var(--color-muted);
		text-decoration: underline;
	}

	.expand-all:hover {
		color: var(--color-text);
	}

	.reply-section {
		margin-top: 1.5rem;
		padding-top: 1.25rem;
		box-shadow: inset 0 1px 0 var(--color-line);
	}


	.reply-to {
		margin-bottom: 0.625rem;
		font-size: 0.8125rem;
		color: var(--color-muted);
	}

	.reply-to strong {
		font-weight: 500;
		color: var(--color-text-secondary);
	}

	.reply-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-top: 0.75rem;
		flex-wrap: wrap;
	}

	.reply-actions {
		display: flex;
		gap: 0.5rem;
		margin-left: auto;
	}

	.reply-status {
		margin-top: 0.75rem;
		font-size: 0.875rem;
		color: var(--color-danger);
	}

	/* Dormant reply box at the foot of the thread; opens the composer. */
	.reply-prompt {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		margin-top: 1.5rem;
		padding: 0.75rem 1rem;
		border-radius: 9999px;
		font-size: 0.875rem;
		color: var(--color-text-secondary);
		box-shadow: inset 0 0 0 1px var(--color-line);
		transition: background 0.15s;
	}

	.reply-prompt:hover {
		background: var(--color-surface-muted);
	}
</style>
