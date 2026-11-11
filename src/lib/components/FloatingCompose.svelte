<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import Icon from './Icon.svelte';
	import RichTextEditor from './RichTextEditor.svelte';
	import AttachmentPicker from './AttachmentPicker.svelte';
	import { htmlToPlainText, isHtmlEmpty } from '#lib/utils/html.ts';
	import { AUTOSAVE_MS, shouldAutosave } from '#lib/writing/autosave.ts';
	import { applySignature } from '#lib/writing/signature.ts';
	import { holdSend, isFutureSchedule } from '#lib/writing/hold-send.ts';
	import type { MailAddress, OutboundAttachmentInput } from '#lib/types.ts';

	let {
		addresses,
		onClose
	}: {
		addresses: MailAddress[];
		onClose: () => void;
	} = $props();

	const defaultAddressId = $derived(
		addresses.find((address) => address.is_default)?.id ?? addresses[0]?.id ?? ''
	);

	let chosenAddressId = $state('');
	const fromAddressId = $derived(chosenAddressId || defaultAddressId);

	/** No signature is stored for an address until Settings saves one. */
	function signatureFor(nextFrom: string | null | undefined): string | null {
		const match = addresses.find((item) => item.address === nextFrom) as
			| (MailAddress & { signature_html?: string | null })
			| undefined;
		const value = match?.signature_html?.trim();
		return value ? value : null;
	}

	function changeFrom(nextId: string) {
		chosenAddressId = nextId;
		const next = addresses.find((address) => address.id === nextId);
		html = applySignature(html, signatureFor(next?.address ?? null));
	}

	let to = $state('');
	let cc = $state('');
	let bcc = $state('');
	let subject = $state('');
	let html = $state(
		untrack(() =>
			applySignature(
				'<p></p>',
				signatureFor(
					addresses.find((address) => address.is_default)?.address ?? addresses[0]?.address ?? null
				)
			)
		)
	);
	let attachments = $state<OutboundAttachmentInput[]>([]);
	let showCopies = $state(false);
	let error = $state('');
	let sending = $state(false);
	let minimized = $state(false);
	let draftId = $state<string | null>(null);
	let edited = $state(false);
	let draftScheduled = $state(false);
	let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
	let autosaveFlight: Promise<void> = Promise.resolve();

	const isEmpty = $derived(!to.trim() && !subject.trim() && isHtmlEmpty(html));

	function clearAutosaveTimer() {
		if (autosaveTimer !== undefined) {
			clearTimeout(autosaveTimer);
			autosaveTimer = undefined;
		}
	}

	function markEdited() {
		edited = true;
		clearAutosaveTimer();
		autosaveTimer = setTimeout(() => {
			autosaveFlight = runAutosave();
		}, AUTOSAVE_MS);
	}

	async function runAutosave() {
		if (!shouldAutosave(edited) || draftScheduled) return;
		try {
			const res = await fetch('/api/drafts', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					id: draftId,
					fromAddressId,
					to,
					cc: cc.trim() || undefined,
					bcc: bcc.trim() || undefined,
					subject,
					html,
					text: isHtmlEmpty(html) ? '' : htmlToPlainText(html),
					...(attachments.length > 0 ? { attachments } : {})
				})
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				error = "Couldn't save draft";
				return;
			}
			if (body.id) draftId = body.id;
			if (error === "Couldn't save draft") error = '';
		} catch {
			error = "Couldn't save draft";
		}
	}

	onDestroy(() => {
		clearAutosaveTimer();
	});

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!to.trim() || isHtmlEmpty(html)) {
			error = to.trim() ? 'Write a message' : 'Add a recipient';
			return;
		}

		clearAutosaveTimer();
		await autosaveFlight;
		edited = false;
		sending = true;
		error = '';
		let holding = false;

		try {
			const res = await fetch('/api/mail', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					draftId: draftId ?? undefined,
					mode: 'new',
					fromAddressId,
					to: to.trim(),
					cc: cc.trim(),
					bcc: bcc.trim(),
					subject,
					html,
					text: htmlToPlainText(html),
					attachments
				})
			});
			const body = await res.json();
			if (!res.ok) {
				error = body.error ?? 'Failed to send';
				return;
			}
			const queuedId = typeof body.id === 'string' ? body.id : '';
			const sendAt = typeof body.sendAt === 'string' ? body.sendAt : '';
			if (queuedId && sendAt && isFutureSchedule(sendAt, new Date())) {
				onClose();
				await goto('/scheduled');
				return;
			}
			if (!queuedId || !sendAt) {
				onClose();
				return;
			}
			draftScheduled = true;
			holding = true;
			holdSend(queuedId, sendAt, {
				onDraft: (id) => {
					draftId = id;
					draftScheduled = false;
					sending = false;
				},
				onClose: () => {
					sending = false;
					onClose();
				}
			});
		} catch {
			error = 'Network error';
		} finally {
			if (!holding) sending = false;
		}
	}

	function handleMinimize() {
		minimized = !minimized;
	}
</script>

{#if !minimized}
	<div class="floating-compose">
		<form class="compose-card" onsubmit={submit}>
			<header class="compose-header">
				<h2 class="compose-title">New Message</h2>
				<div class="compose-controls">
					<button
						type="button"
						class="control-btn"
						aria-label="Minimize"
						onclick={handleMinimize}
					>
						<Icon name="subtract-line" size={16} />
					</button>
					<button type="button" class="control-btn" aria-label="Close" onclick={onClose}>
						<Icon name="close-line" size={16} />
					</button>
				</div>
			</header>

			<div class="compose-fields">
				{#if addresses.length > 1}
					<div class="compose-row">
						<span class="field-label">From</span>
						<select
							value={fromAddressId}
							onchange={(event) => changeFrom(event.currentTarget.value)}
							class="field-select"
							aria-label="Send from"
						>
							{#each addresses as address (address.id)}
								<option value={address.id}>{address.address}</option>
							{/each}
						</select>
					</div>
				{/if}

				<div class="compose-row">
					<span class="field-label">To</span>
					<input
						type="text"
						bind:value={to}
						required
						placeholder="Recipients"
						class="field-input"
						oninput={markEdited}
					/>
				</div>

				{#if showCopies}
					<div class="compose-row">
						<span class="field-label">Cc</span>
						<input
							type="text"
							bind:value={cc}
							placeholder="Recipients"
							class="field-input"
							oninput={markEdited}
						/>
					</div>
					<div class="compose-row">
						<span class="field-label">Bcc</span>
						<input
							type="text"
							bind:value={bcc}
							placeholder="Recipients"
							class="field-input"
							oninput={markEdited}
						/>
					</div>
				{:else}
					<button
						type="button"
						class="cc-bcc-toggle"
						onclick={() => (showCopies = true)}
					>
						Cc / Bcc
					</button>
				{/if}

				<div class="compose-row">
					<input
						type="text"
						bind:value={subject}
						required
						placeholder="Subject"
						class="field-input"
						oninput={markEdited}
					/>
				</div>
			</div>

			<!-- Assigning HTML does not fire input. Only typing does. -->
			<div class="compose-body" oninput={markEdited}>
				<RichTextEditor offerTimes bind:html minHeight={240} />
			</div>

			<div class="compose-attachments">
				<AttachmentPicker bind:attachments />
			</div>

			{#if error}
				<p class="compose-error">{error}</p>
			{/if}

			<footer class="compose-footer">
				<button type="submit" class="btn-send" disabled={sending || !to.trim()}>
					<Icon name="send-plane-2-fill" size={16} />
					{sending ? 'Sending…' : 'Send'}
				</button>
				<div class="compose-actions">
					<button type="button" class="icon-btn-sm" title="Discard" onclick={onClose}>
						<Icon name="delete-bin-line" size={16} />
					</button>
				</div>
			</footer>
		</form>
	</div>
{:else}
	<button class="minimized-compose" onclick={handleMinimize}>
		<Icon name="mail-line" size={16} />
		<span>New Message</span>
	</button>
{/if}

<style>
	.floating-compose {
		position: fixed;
		bottom: 0;
		right: 2rem;
		z-index: 100;
		width: 32rem;
		max-width: calc(100vw - 4rem);
		max-height: calc(100vh - 4rem);
		display: flex;
		flex-direction: column;
		background: var(--color-surface);
		border-radius: 0.5rem 0.5rem 0 0;
		box-shadow: 0 8px 10px 1px rgba(0, 0, 0, 0.14), 0 3px 14px 2px rgba(0, 0, 0, 0.12),
			0 5px 5px -3px rgba(0, 0, 0, 0.2);
	}

	.compose-card {
		display: flex;
		flex-direction: column;
		height: 100%;
		max-height: calc(100vh - 4rem);
	}

	.compose-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.75rem 1rem;
		background: var(--color-surface-muted);
		border-radius: 0.5rem 0.5rem 0 0;
		box-shadow: inset 0 -1px 0 var(--color-line);
	}

	.compose-title {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--color-text);
	}

	.compose-controls {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}

	.control-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: 50%;
		color: var(--color-text-secondary);
		transition: background 0.2s;
	}

	.control-btn:hover {
		background: var(--color-surface-hover);
	}

	.compose-fields {
		border-bottom: 1px solid var(--color-line);
	}

	.compose-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.625rem 1rem;
		box-shadow: inset 0 -1px 0 var(--color-line);
	}

	.compose-row:last-child {
		box-shadow: none;
	}

	.field-label {
		flex-shrink: 0;
		width: 2.5rem;
		font-size: 0.875rem;
		color: var(--color-text-secondary);
	}

	.field-input,
	.field-select {
		flex: 1;
		padding: 0.25rem 0;
		font-size: 0.875rem;
		color: var(--color-text);
		background: transparent;
		border: none;
		outline: none;
	}

	.field-input::placeholder {
		color: var(--color-text-secondary);
	}

	.cc-bcc-toggle {
		padding: 0.25rem 1rem;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		text-align: left;
		transition: color 0.2s;
	}

	.cc-bcc-toggle:hover {
		color: var(--color-text);
	}

	.compose-body {
		flex: 1;
		overflow-y: auto;
		padding: 1rem;
		min-height: 240px;
	}

	.compose-attachments {
		padding: 0 1rem;
	}

	.compose-error {
		padding: 0 1rem 0.5rem;
		font-size: 0.8125rem;
		color: var(--color-danger);
	}

	.compose-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 1rem;
		box-shadow: inset 0 1px 0 var(--color-line);
	}

	.btn-send {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		padding: 0.625rem 1.5rem;
		border-radius: 1.5rem;
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--color-on-accent);
		background: var(--color-link);
		box-shadow: var(--shadow-xs);
		transition: background 0.2s, box-shadow 0.2s;
	}

	.btn-send:hover:not(:disabled) {
		background: var(--color-link-hover);
		box-shadow: var(--shadow-sm);
	}

	.btn-send:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.compose-actions {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}

	.icon-btn-sm {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: 50%;
		color: var(--color-text-secondary);
		transition: background 0.2s;
	}

	.icon-btn-sm:hover {
		background: var(--color-surface-hover);
	}

	.minimized-compose {
		position: fixed;
		bottom: 0;
		right: 2rem;
		z-index: 100;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem 1.5rem;
		background: var(--color-surface);
		border-radius: 0.5rem 0.5rem 0 0;
		box-shadow: var(--shadow-md);
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--color-text);
		transition: background 0.2s;
	}

	.minimized-compose:hover {
		background: var(--color-surface-hover);
	}

	@media (max-width: 640px) {
		.floating-compose {
			right: 0;
			left: 0;
			width: 100%;
			max-width: 100%;
		}

		.minimized-compose {
			right: 1rem;
		}
	}
</style>
