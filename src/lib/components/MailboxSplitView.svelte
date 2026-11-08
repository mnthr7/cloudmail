<script lang="ts">
	import { parseEmailAddress } from '#lib/email-address.ts';
	import { onDestroy, tick } from 'svelte';
	import { page } from '$app/state';
	import { goto, invalidateAll } from '$app/navigation';
	import MailboxView from './MailboxView.svelte';
	import OrganizeMenu from './OrganizeMenu.svelte';
	import AskAgentForm from './AskAgentForm.svelte';
	import SuggestedReplies from './SuggestedReplies.svelte';
	import { withSuggestion, writtenText, type SuggestionRef, type SuggestionView } from '#lib/agents/suggestions.ts';
	import Icon from './Icon.svelte';
	import ThreadMessage from './ThreadMessage.svelte';
	import RichTextEditor from './RichTextEditor.svelte';
	import AttachmentPicker from './AttachmentPicker.svelte';
	import FromAddressSelect from './FromAddressSelect.svelte';
	import { htmlToPlainText, isHtmlEmpty } from '#lib/utils/html.ts';
	import { formatFullDate } from '#lib/utils/date.ts';
	import { showToast } from '#lib/toast.ts';
	import { AUTOSAVE_MS, shouldAutosave } from '#lib/writing/autosave.ts';
	import { composerDraft, type ComposerMode } from '#lib/writing/composer.ts';
	import { holdSend, isFutureSchedule } from '#lib/writing/hold-send.ts';
	import { applySignature } from '#lib/writing/signature.ts';
	import {
		defaultReplyFromKey,
		matchThreadReplyFrom,
		replyFromOptions
	} from '#lib/reply-from.ts';
	import type {
		Domain,
		MailAddress,
		MailboxFilters,
		MailboxPage,
		MailboxView as MailboxViewType,
		OutboundAttachmentInput,
		User
	} from '#lib/types.ts';

	let {
		view,
		mailbox,
		filters
	}: {
		view: MailboxViewType;
		mailbox: MailboxPage;
		filters: MailboxFilters;
	} = $props();

	let threadId = $state<string | null>(null);
	let threadData = $state<any>(null);
	let loadingThread = $state(false);
	let replyHtml = $state('');
	let replyAttachments = $state<OutboundAttachmentInput[]>([]);
	let composer = $state<ComposerMode | null>(null);
	let composeMode = $state<ComposerMode | null>(null);
	let composeTo = $state('');
	let composeCc = $state('');
	let composeBcc = $state('');
	let composeSubject = $state('');
	let replyDraftId = $state<string | null>(null);
	let edited = $state(false);
	let draftScheduled = $state(false);
	let sending = $state(false);
	let error = $state('');
	let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
	let autosaveFlight: Promise<void> = Promise.resolve();
	let restoredThreadId: string | null = null;

	type SavedDraft = {
		id: string;
		to_addr: string;
		cc_addr: string | null;
		bcc_addr: string | null;
		subject: string;
		body_html: string | null;
		draft_action: string | null;
		status: string;
	};

	function isComposerMode(value: unknown): value is ComposerMode {
		return value === 'reply' || value === 'reply-all' || value === 'forward';
	}

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
		const sourceId = latest?.id;
		const mode = composeMode;
		const requestThreadId = threadId;
		if (!shouldAutosave(edited) || draftScheduled || !mode || !sourceId || !requestThreadId) return;

		const selected = fromOptions.find((option) => option.key === fromKey);
		try {
			const res = await fetch('/api/drafts', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					id: replyDraftId ?? undefined,
					sourceEmailId: sourceId,
					draftAction: mode,
					fromAddressId: selected?.addressId ?? undefined,
					fromAddress: selected?.address,
					to: composeTo,
					cc: composeCc.trim() || undefined,
					bcc: composeBcc.trim() || undefined,
					subject: composeSubject,
					html: replyHtml,
					text: isHtmlEmpty(replyHtml) ? '' : htmlToPlainText(replyHtml),
					...replyAttachments.length > 0 ? { attachments: replyAttachments } : {}
				})
			});
			const body = await res.json().catch(() => ({}));
			// latest stays on the previous conversation until its fetch returns.
			if (threadId !== requestThreadId || latest?.id !== sourceId) return;
			if (!res.ok) {
				error = "Couldn't save draft";
				return;
			}
			if (body.id) replyDraftId = body.id;
			if (error === "Couldn't save draft") error = '';
		} catch {
			if (threadId !== requestThreadId || latest?.id !== sourceId) return;
			error = "Couldn't save draft";
		}
	}

	onDestroy(() => {
		clearAutosaveTimer();
		if (suggestPoll) clearTimeout(suggestPoll);
	});
	/** Threads removed optimistically; hidden from the list until the server agrees. */
	let hiddenIds = $state<string[]>([]);

	// Track opened messages in thread
	let opened = $state(new Set<string>());

	// Watch URL for thread parameter
	$effect(() => {
		const urlThreadId = page.url.searchParams.get('thread');
		if (urlThreadId !== threadId) {
			threadId = urlThreadId;
			if (urlThreadId) {
				loadThread(urlThreadId);
			} else {
				threadData = null;
				loadingThread = false;
				composer = null;
				composeMode = null;
				replyHtml = '';
				replyDraftId = null;
				draftScheduled = false;
				edited = false;
				restoredThreadId = null;
				clearAutosaveTimer();
			}
		}
	});

	// Initialize opened messages when thread data loads
	$effect(() => {
		if (threadData?.messages) {
			const initial = new Set<string>();
			const last = threadData.messages[threadData.messages.length - 1];
			if (last) initial.add(last.id);
			opened = initial;
		}
	});

	function mailApiUrl(id: string): string {
		return `/api/mail/${id}`;
	}

	function applySavedDraft(saved: SavedDraft) {
		replyDraftId = saved.id;
		draftScheduled = saved.status === 'scheduled';
		composeTo = saved.to_addr ?? '';
		composeCc = saved.cc_addr ?? '';
		composeBcc = saved.bcc_addr ?? '';
		composeSubject = saved.subject ?? '';
		replyHtml = saved.body_html ?? '';
		edited = false;
		if (isComposerMode(saved.draft_action)) {
			composeMode = saved.draft_action;
			composer = saved.draft_action;
		}
	}

	function clearPreviousDraft() {
		composer = null;
		composeMode = null;
		replyDraftId = null;
		draftScheduled = false;
		replyHtml = '';
	}

	let askOpen = $state(false);
	const askAgents = $derived<Array<{ id: string; name: string }>>(threadData?.agents ?? []);

	// Suggested replies: the open set for this thread, which one a reply started from,
	// and a one-click request that waits for the agent to answer.
	const suggestion = $derived<SuggestionView | null>(threadData?.suggestion ?? null);
	let suggestionRef = $state<SuggestionRef | null>(null);
	let suggestWaiting = $state(false);
	let suggestPoll: ReturnType<typeof setTimeout> | null = null;
	const hasInbound = $derived(
		(threadData?.messages ?? []).some((message: { direction: string }) => message.direction === 'inbound')
	);

	function stopSuggestPoll() {
		if (suggestPoll) clearTimeout(suggestPoll);
		suggestPoll = null;
		suggestWaiting = false;
	}

	$effect(() => {
		if (!composer) suggestionRef = null;
	});

	async function useSuggestion(index: number, sendNow: boolean) {
		const option = suggestion?.options[index];
		if (!suggestion || !option) return;
		if (composer !== 'reply') openComposer('reply');
		if (composer !== 'reply') return;
		replyHtml = withSuggestion(replyHtml, option.body);
		suggestionRef = { id: suggestion.id, index };
		if (sendNow) {
			await tick();
			await sendReply(new Event('submit'));
		} else {
			void focusReplyComposer();
		}
	}

	async function dismissSuggestion() {
		if (!suggestion) return;
		const id = suggestion.id;
		threadData = { ...threadData, suggestion: null };
		await fetch(`/api/agents/suggestions/${id}`, { method: 'DELETE' }).catch(() => undefined);
	}

	async function requestSuggestions() {
		const agent = askAgents[0];
		if (!agent || !latest || !threadId) return;
		const forThread = threadId;
		const res = await fetch(`/api/agents/${agent.id}/ask`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ emailId: latest.id, suggest: true })
		}).catch(() => null);
		if (!res?.ok) {
			const body = await res?.json().catch(() => null);
			showToast(
				body?.error === 'paused'
					? `${agent.name} is paused. Resume it on the Staff page first.`
					: body?.error === 'drafting'
						? `${agent.name} isn't allowed to draft replies. Turn drafting on in its settings.`
						: "Couldn't ask for replies.",
				{ kind: 'error' }
			);
			return;
		}
		suggestWaiting = true;
		let tries = 0;
		const check = async () => {
			if (threadId !== forThread) return stopSuggestPoll();
			const next = await fetch(mailApiUrl(forThread)).then((r) => (r.ok ? r.json() : null)).catch(() => null);
			if (threadId !== forThread) return stopSuggestPoll();
			if (next?.suggestion) {
				threadData = { ...threadData, suggestion: next.suggestion };
				return stopSuggestPoll();
			}
			if (++tries >= 24) {
				stopSuggestPoll();
				showToast(`${agent.name} hasn't answered yet. Check the Staff page for what happened.`);
				return;
			}
			suggestPoll = setTimeout(check, 10_000);
		};
		suggestPoll = setTimeout(check, 15_000);
	}

	async function loadThread(id: string) {
		const requestThreadId = id;
		const opening = restoredThreadId !== requestThreadId;
		if (opening) {
			askOpen = false;
			stopSuggestPoll();
			clearAutosaveTimer();
			edited = false;
			clearPreviousDraft();
		}
		loadingThread = true;
		try {
			const res = await fetch(mailApiUrl(requestThreadId));
			if (threadId !== requestThreadId) return;
			if (res.ok) {
				const body = await res.json();
				if (threadId !== requestThreadId) return;
				threadData = body;
				if (opening) {
					restoredThreadId = requestThreadId;
					const saved = body.draft as SavedDraft | null;
					if (saved && isComposerMode(saved.draft_action)) applySavedDraft(saved);
					else clearPreviousDraft();
				}
				// GET already marked the thread read in D1. Changing ?thread= does
				// not refetch the mailbox (load ignores that param), so refresh
				// the list + sidebar unread badge without a full page reload.
				void invalidateAll();
			} else if (threadId === requestThreadId) {
				threadData = null;
			}
		} catch (err) {
			if (threadId !== requestThreadId) return;
			console.error('Failed to load thread:', err);
			threadData = null;
		} finally {
			if (threadId === requestThreadId) loadingThread = false;
		}
	}

	function handleThreadSelect(id: string) {
		const params = new URLSearchParams(page.url.search);
		params.set('thread', id);
		goto(`${page.url.pathname}?${params}`, { reset: false });
	}

	function closeThread() {
		const params = new URLSearchParams(page.url.search);
		params.delete('thread');
		goto(`${page.url.pathname}${params.size ? `?${params}` : ''}`, { reset: false });
	}

	function toggleMessage(id: string) {
		const next = new Set(opened);
		if (next.has(id) && next.size > 1) next.delete(id);
		else next.add(id);
		opened = next;
	}

	function expandAll() {
		if (threadData?.messages) {
			opened = new Set(threadData.messages.map((m: any) => m.id));
		}
	}

	const messages = $derived(threadData?.messages ?? []);
	const latest = $derived(messages[messages.length - 1]);
	const starred = $derived(messages.some((m: any) => m.is_starred));
	const collapsedCount = $derived(messages.filter((m: any) => !opened.has(m.id)).length);

	// Ledger's metadata column (From / To / Date / Thread / Last sent / Attachments).
	const people = $derived(new Set(messages.map((m: any) => m.direction === 'outbound' ? 'me' : m.from_addr)).size);

	const lastSent = $derived([...messages].reverse().find((m: any) => m.direction === 'outbound'));
	const attachmentCount = $derived(
		messages.reduce((sum: number, m: any) => sum + (m.attachments?.length ?? 0), 0)
	);
	const mailboxLabel = $derived(view.charAt(0).toUpperCase() + view.slice(1));

	const trustedAddresses = $derived((page.data.trustedAddresses ?? []) as string[]);
	const addresses = $derived((page.data.addresses ?? []) as MailAddress[]);
	const domains = $derived((page.data.domains ?? []) as Domain[]);
	const userId = $derived((page.data.user as User | null)?.id ?? '');
	const replyFrom = $derived(matchThreadReplyFrom(messages, addresses, domains, userId));
	const fromOptions = $derived(
		replyFromOptions(addresses, replyFrom.preferred, replyFrom.also)
	);
	const defaultFromKey = $derived(defaultReplyFromKey(addresses, replyFrom.preferred));
	let chosenFromKey = $state('');
	const fromKey = $derived(chosenFromKey || defaultFromKey);

	$effect(() => {
		void latest?.id;
		chosenFromKey = '';
	});

	const recipientsEmpty = $derived(composeTo.split(',').every((part) => part.trim() === ''));

	/** No signature is stored for an address until Settings saves one. */
	function signatureFor(nextFrom: string | null | undefined): string | null {
		const match = addresses.find((item) => item.address === nextFrom) as 
			(MailAddress & { signature_html?: string | null }) |
			undefined;
		const value = match?.signature_html?.trim();
		return value ? value : null;
	}

	function draftFor(mode: ComposerMode) {
		if (!latest) return null;
		const selected = fromOptions.find((option) => option.key === fromKey);
		return composerDraft({
			mode,
			direction: latest.direction === 'outbound' ? 'outbound' : 'inbound',
			from: latest.from_addr,
			replyTo: latest.reply_to_header ?? null,
			to: latest.to_addr ?? null,
			cc: latest.cc_addr ?? null,
			bcc: latest.bcc_addr ?? null,
			own: [
				...addresses.map((address) => address.address),
				...selected?.address ? [selected.address] : []
			],
			subject: latest.subject || threadData?.subject || '',
			createdAt: latest.created_at,
			html: latest.body_html,
			text: latest.body_text,
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			signatureHtml: signatureFor(selected?.address ?? null),
			remoteImages: trustedAddresses.some(
				(address) => address.toLowerCase() === parseEmailAddress(latest.from_addr)
			)
		});
	}

	const showReplyAll = $derived(latest ? draftFor('reply')?.showReplyAll ?? false : false);

	/** Scroll the open composer into the reading pane and put the caret in it. */
	function revealReplyComposer() {
		const section = document.querySelector<HTMLElement>('.thread-pane .reply-section');
		const editor = section?.querySelector<HTMLElement>('[contenteditable="true"]');
		const scroller = section?.closest<HTMLElement>('.thread-content');
		if (!section || !editor || !scroller) return;

		const scrollerRect = scroller.getBoundingClientRect();
		const sectionRect = section.getBoundingClientRect();
		const editorRect = editor.getBoundingClientRect();
		const pad = 12;
		// Keep Send beside the writing line. The quote continues below it.
		const footer = section.querySelector<HTMLElement>('.reply-footer');
		const anchor = footer ?? (editorRect.top - sectionRect.top + 120 < scroller.clientHeight - pad ? section : editor);
		const anchorTop = anchor.getBoundingClientRect().top;
		const next = scroller.scrollTop + (anchorTop - scrollerRect.top) - pad;
		const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
		const top = Math.max(0, Math.min(next, max));
		scroller.scrollTop = top;

		editor.focus({ preventScroll: true });
		const paragraph = editor.querySelector('p');
		const selection = window.getSelection();
		if (selection) {
			const range = document.createRange();
			range.setStart(paragraph ?? editor, 0);
			range.collapse(true);
			selection.removeAllRanges();
			selection.addRange(range);
		}
		scroller.scrollTop = top;
	}

	async function focusReplyComposer() {
		await tick();
		requestAnimationFrame(() => {
			revealReplyComposer();
			// The editor paints its quote after the first frame. Place the caret again.
			requestAnimationFrame(revealReplyComposer);
		});
	}

	function openComposer(mode: ComposerMode) {
		if (composer === mode) {
			composer = null;
			return;
		}
		clearAutosaveTimer();
		edited = false;
		// Closing and reopening the same reply keeps what is already on screen.
		// A fresh quote is not an edit, so it does not start a draft.
		if (composeMode === mode && (replyDraftId || replyHtml)) {
			composer = mode;
			void focusReplyComposer();
			return;
		}
		const draft = draftFor(mode);
		if (!draft) return;
		composeTo = draft.to.join(', ');
		composeCc = '';
		composeBcc = '';
		composeSubject = draft.subject;
		replyHtml = draft.html;
		error = '';
		composeMode = mode;
		composer = mode;
		void focusReplyComposer();
	}

	function changeFrom(key: string) {
		chosenFromKey = key;
		const next = fromOptions.find((option) => option.key === key);
		replyHtml = applySignature(replyHtml, signatureFor(next?.address));
	}

	async function patch(body: Record<string, boolean>, id = latest?.id): Promise<boolean> {
		if (!id) return false;
		try {
			const res = await fetch(mailApiUrl(id), {
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
		const next = !starred;
		// Flip first; the server catches up. Put it back if it refuses.
		if (threadData?.messages) {
			threadData = {
				...threadData,
				messages: threadData.messages.map((m: any) => ({ ...m, is_starred: next }))
			};
		}

		if (!await patch({ isStarred: next })) {
			showToast("Couldn't update the star. Check your connection and try again.", { kind: 'error' });
		}
		await invalidateAll();
		if (threadId) await loadThread(threadId);
	}

	/**
	 * Optimistic: the reader closes and the row disappears at once. The request
	 * runs in the background; a failure brings the row back with an error, and
	 * Undo restores it.
	 */
	async function dismiss(kind: 'trash' | 'spam' | 'unspam') {
		const id = latest?.id;
		if (!id) return;

		const body: Record<string, boolean> =
			kind === 'trash' ? { trashed: true } : kind === 'spam' ? { spam: true } : { spam: false };
		const undo: Record<string, boolean> =
			kind === 'trash' ? { trashed: false } : kind === 'spam' ? { spam: false } : { spam: true };
		const done =
			kind === 'trash' ? 'Moved to trash' : kind === 'spam' ? 'Marked as spam' : 'Removed from spam';
		const fail =
			kind === 'trash'
			? "Couldn't move to trash. The message is still in your inbox."
			: kind === 'spam'
				? "Couldn't mark as spam. The message is still here."
				: "Couldn't move it out of spam.";
		const undoFail =
			kind === 'spam'
			? "Couldn't undo. Find it in Spam."
				: kind === 'unspam'
					? "Couldn't undo."
					: "Couldn't undo. Find it in Trash.";

		hiddenIds = [...hiddenIds, id];
		threadData = null;
		composer = null;
		replyHtml = '';
		closeThread();

		const ok = await patch(body, id);
		if (!ok) {
			hiddenIds = hiddenIds.filter((value) => value !== id);
			showToast(fail, { kind: 'error' });
			await invalidateAll();
			return;
		}

		showToast(done, {
			actionLabel: 'Undo',
			onAction: async () => {
				const restored = await patch(undo, id);
				hiddenIds = hiddenIds.filter((value) => value !== id);
				if (!restored) showToast(undoFail, { kind: 'error' });
				await invalidateAll();
			}
		});
		await invalidateAll();
		hiddenIds = hiddenIds.filter((value) => value !== id);
	}

	function clearSentComposer() {
		replyHtml = '';
		replyAttachments = [];
		composeTo = '';
		composeCc = '';
		composeBcc = '';
		composeSubject = '';
		replyDraftId = null;
		composeMode = null;
		draftScheduled = false;
		composer = null;
	}

	async function sendReply(event: Event, archive = false) {
		event.preventDefault();
		if (!latest || !composer || recipientsEmpty || isHtmlEmpty(replyHtml)) return;

		clearAutosaveTimer();
		await autosaveFlight;
		edited = false;
		sending = true;
		error = '';
		let holding = false;

		try {
			const selected = fromOptions.find((option) => option.key === fromKey);
			const res = await fetch(mailApiUrl(latest.id), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mode: composer,
					html: replyHtml,
					text: htmlToPlainText(replyHtml),
					to: composeTo.trim(),
					cc: composeCc.trim(),
					bcc: composeBcc.trim(),
					subject: composeSubject.trim(),
					fromAddressId: selected?.addressId ?? undefined,
					fromAddress: selected?.address,
					...archive ? { archive: true } : { archive: false },
					attachments: replyAttachments,
					...(suggestionRef && composer === 'reply'
						? { suggestion: { ...suggestionRef, text: writtenText(replyHtml) } }
						: {})
				})
			});
			const body = await res.json();
			if (!res.ok) {
				error = body.error ?? 'Failed to send';
				return;
			}

			const queuedId = typeof body.id === 'string' ? body.id : '';
			const sendAt = typeof body.sendAt === 'string' ? body.sendAt : '';
			// Any reply closes the open suggestions: one was used, or the user wrote their own.
			if (threadData?.suggestion && composer !== 'forward') threadData = { ...threadData, suggestion: null };
			suggestionRef = null;
			if (replyDraftId && replyDraftId !== queuedId) {
				await fetch(`/api/drafts/${replyDraftId}`, { method: 'DELETE' });
			}
			await invalidateAll();

			if (queuedId && sendAt && isFutureSchedule(sendAt, new Date())) {
				clearSentComposer();
				await goto('/scheduled');
				return;
			}

			if (!queuedId || !sendAt) {
				clearSentComposer();
				return;
			}

			draftScheduled = true;
			holding = true;
			holdSend(queuedId, sendAt, {
				onDraft: (id) => {
					replyDraftId = id;
					draftScheduled = false;
					sending = false;
					void invalidateAll();
				},
				onClose: () => {
					clearSentComposer();
					sending = false;
					void invalidateAll();
				}
			});
		} catch {
			error = 'Network error';
		} finally {
			if (!holding) sending = false;
		}
	}
</script>

<div class="split-layout">
	<div class="list-pane">
		<MailboxView
			view={view}
			mailbox={mailbox}
			filters={filters}
			hiddenIds={hiddenIds}
			onThreadSelect={handleThreadSelect}
			selectedThreadId={threadId}
		/>
	</div>

	<div class="thread-pane" class:has-thread={Boolean(threadId)}>
		{#if loadingThread}
			<div class="thread-loading">
				<p>Loading...</p>
			</div>
		{:else if threadData}
			<div class="thread-container">
				<header class="thread-toolbar">
					<button
						type="button"
						class="close-thread-btn"
						onclick={closeThread}
						aria-label="Close"
						data-kb="close"
					>
						<Icon name="close-line" size={18} />
						<span class="btn-text skin-only">Close</span>
					</button>

					<div class="thread-actions">
						<button
							type="button"
							class="icon-btn"
							class:starred
							aria-label={starred ? 'Remove star' : 'Add star'}
							onclick={toggleStar}
							data-kb="star-thread"
						>
							<Icon name={starred ? 'star-fill' : 'star-line'} size={16} />
							<span class="btn-text skin-only">{starred ? 'Starred' : 'Star'}</span>
							<kbd class="kb-hint">s</kbd>
						</button>

						{#if view === 'spam'}
							<button
								type="button"
								class="icon-btn"
								aria-label="Not spam"
								onclick={() => dismiss('unspam')}
								data-kb="spam-thread"
							>
								<Icon name="mail-check-line" size={16} />
								<span class="btn-text skin-only">Not spam</span>
								<kbd class="kb-hint">!</kbd>
							</button>
						{:else}
							<button
								type="button"
								class="icon-btn"
								aria-label="Mark as spam"
								onclick={() => dismiss('spam')}
								data-kb="spam-thread"
							>
								<Icon name="spam-2-line" size={16} />
								<span class="btn-text skin-only">Spam</span>
								<kbd class="kb-hint">!</kbd>
							</button>
						{/if}

						<button
							type="button"
							class="icon-btn"
							aria-label="Move to trash"
							onclick={() => dismiss('trash')}
							data-kb="trash-thread"
						>
							<Icon name="delete-bin-line" size={16} />
							<span class="btn-text skin-only">Trash</span>
							<kbd class="kb-hint">#</kbd>
						</button>

						{#if latest}
							<OrganizeMenu
								ids={[latest.id]}
								inInbox={threadData.inInbox !== false}
								muted={Boolean(threadData.isMuted)}
								important={Boolean(threadData.isImportant)}
								category={threadData.category}
								labels={threadData.labels ?? []}
								labeled
								align="right"
								showChips={false}
								onChanged={async () => {
									if (threadId) await loadThread(threadId);
								}}
							/>
						{/if}

						{#if askAgents.length > 0}
							<button type="button" class="btn-ghost" onclick={() => (askOpen = !askOpen)}>
								<Icon name="robot-2-line" size={16} />
								{askOpen ? 'Close' : 'Ask an agent'}
							</button>
						{/if}

						{#if showReplyAll}
							<button type="button" class="btn-ghost" onclick={() => openComposer('reply-all')}>
								<Icon name="reply-all-line" size={16} />
								{composer === 'reply-all' ? 'Close' : 'Reply all'}
							</button>
						{/if}
						<button type="button" class="btn-ghost" onclick={() => openComposer('forward')}>
							<Icon name="share-forward-line" size={16} />
							{composer === 'forward' ? 'Close' : 'Forward'}
						</button>
						<button
							type="button"
							class="btn-primary"
							onclick={() => openComposer('reply')}
							data-kb={composer === 'reply' ? undefined : 'reply'}
						>
							<Icon name="reply-line" size={16} />
							{composer === 'reply' ? 'Close' : 'Reply'}
							{#if composer !== 'reply'}<kbd class="kb-hint">r</kbd>{/if}
						</button>
					</div>
				</header>

				<div class="thread-content">
					<dl class="thread-meta ledger-only">
						{#if latest}
							<dt>From</dt>
							<dd>{latest.direction === 'outbound' ? 'me' : latest.from_addr}</dd>
							<dt>To</dt>
							<dd>{latest.to_addr}</dd>
							<dt>Date</dt>
							<dd>{formatFullDate(latest.created_at)}</dd>
						{/if}
						<dt>Thread</dt>
						<dd>
							{messages.length} message{messages.length === 1 ? '' : 's'} · {people}
							{people === 1 ? 'person' : 'people'}
						</dd>
						{#if lastSent}
							<dt>Last sent</dt>
							<dd class="meta-status">{lastSent.status ?? 'sent'} · {formatFullDate(lastSent.created_at)}</dd>
						{/if}
						{#if attachmentCount > 0}
							<dt>Attachments</dt>
							<dd>{attachmentCount}</dd>
						{/if}
						<div class="meta-keys">
							<kbd>r</kbd><span>reply</span>
							<kbd>s</kbd><span>star</span>
							<kbd>!</kbd><span>spam</span>
							<kbd>#</kbd><span>trash</span>
							<kbd>x</kbd><span>expand all</span>
							<kbd>esc</kbd><span>close</span>
						</div>
					</dl>

					<div class="thread-sheet">
						<p class="thread-kicker skin-only">
						<b>{messages.length} message{messages.length === 1 ? '' : 's'}</b> · {mailboxLabel}{starred
							? ' · Starred'
							: ''}
						</p>
						<div class="subject-row">
							<h1>{threadData.subject || '(no subject)'}</h1>
							{#if messages.length > 1}
								<span class="thread-count">{messages.length} messages</span>
							{/if}
						</div>

						{#if latest && (threadData.labels ?? []).length > 0}
							<OrganizeMenu
								ids={[latest.id]}
								labels={threadData.labels ?? []}
								showMenu={false}
								showChips
								onChanged={async () => {
									if (threadId) await loadThread(threadId);
								}}
							/>
						{/if}

						{#if collapsedCount > 0}
						<button type="button" class="expand-all" onclick={expandAll} data-kb="expand">
							Expand all {messages.length} messages
						</button>
						{/if}

						<div class="thread-messages">
							{#each messages as message (message.id)}
								<ThreadMessage
									message={message}
									trustedAddresses={trustedAddresses}
									expanded={opened.has(message.id)}
									onToggle={() => toggleMessage(message.id)}
								/>
							{/each}
						</div>

						{#if askOpen && latest && askAgents.length > 0}
							<AskAgentForm agents={askAgents} emailId={latest.id} onClose={() => (askOpen = false)} />
						{/if}

						<SuggestedReplies
							{suggestion}
							agentName={hasInbound ? (askAgents[0]?.name ?? null) : null}
							waiting={suggestWaiting}
							busy={sending}
							onUse={useSuggestion}
							onDismiss={dismissSuggestion}
							onRequest={requestSuggestions}
						/>
					</div>

					{#if composer}
						<form class="reply-section" onsubmit={sendReply}>
							<p class="reply-to">
								{#if composer === 'forward'}
									Forward
								{:else if composer === 'reply-all'}
									Reply all
								{:else}
									Reply
								{/if}
							</p>

							<label class="reply-field">
								<span>To</span>
								<input type="text" bind:value={composeTo} placeholder="Recipients" oninput={markEdited} />
							</label>
							<label class="reply-field">
								<span>Cc</span>
								<input type="text" bind:value={composeCc} placeholder="Recipients" oninput={markEdited} />
							</label>
							<label class="reply-field">
								<span>Bcc</span>
								<input type="text" bind:value={composeBcc} placeholder="Recipients" oninput={markEdited} />
							</label>
							<label class="reply-field">
								<span>Subject</span>
								<input type="text" bind:value={composeSubject} oninput={markEdited} />
							</label>

							<FromAddressSelect options={fromOptions} value={fromKey} onchange={changeFrom} />

							<div class="reply-footer">
								<AttachmentPicker bind:attachments={replyAttachments} />
								<div class="reply-actions">
									<button
										type="button"
										class="btn-ghost"
										onclick={() => composer = null}
									>Cancel</button>

									{#if composer === 'reply' || composer === 'reply-all' || composer === 'forward'}
										<button
											type="button"
											class="btn-ghost"
											disabled={sending || recipientsEmpty}
											onclick={(event) => sendReply(event, true)}
										>
											Send and archive
										</button>
									{/if}
									<button type="submit" class="btn-primary" disabled={sending || recipientsEmpty}>
										<Icon name="send-plane-2-fill" size={16} />
										{sending ? 'Sending…' : 'Send'}
									</button>
								</div>
							</div>

							{#if error}
								<p class="reply-status">{error}</p>
							{/if}

							{#key composer}
								<!-- Assigning HTML does not fire input. Only typing does. -->
								<div oninput={markEdited}>
									<RichTextEditor
										bind:html={replyHtml}
										embedded
										minHeight={160}
										placeholder="Write your message…"
									/>
								</div>
							{/key}
						</form>
					{:else}
						<div class="reply-prompts">
							<button
								type="button"
								class="reply-prompt"
								onclick={() => openComposer('reply')}
								data-kb="reply"
							>
								<Icon name="reply-line" size={15} />
								Reply
							</button>
							{#if showReplyAll}
								<button type="button" class="reply-prompt" onclick={() => openComposer('reply-all')}>
									<Icon name="reply-all-line" size={15} />
									Reply all
								</button>
							{/if}
							<button type="button" class="reply-prompt" onclick={() => openComposer('forward')}>
								<Icon name="share-forward-line" size={15} />
								Forward
							</button>
						</div>
					{/if}
				</div>
			</div>
		{:else if threadId}
			<div class="thread-empty">
				<p>Thread not found</p>
			</div>
		{:else}
			<div class="thread-empty">
				<Icon name="mail-line" size={48} />
				<p>No conversation selected</p>
			</div>
		{/if}
	</div>
</div>

<style>
	.split-layout {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}

	.list-pane {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
	}

	.thread-pane {
		display: none;
		flex-direction: column;
		background: var(--color-bg);
	}

	/* Mobile: full-screen thread view when selected */
	.thread-pane.has-thread {
		display: flex;
		flex: 1;
		min-height: 0;
	}

	.list-pane:has(+ .thread-pane.has-thread) {
		display: none;
	}

	/* Desktop split variants live in layout.css so they can follow
	   html[data-reading-pane] immediately, including before hydrate. */

	.thread-loading,
	.thread-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 1rem;
		height: 100%;
		padding: 4rem 2rem;
		color: var(--color-text-secondary);
		text-align: center;
	}

	.thread-container {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		height: 100%;
		background: var(--color-surface);
	}

	.thread-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.75rem 1.25rem;
		border-bottom: 1px solid var(--color-line);
		background: var(--color-surface);
	}

	.close-thread-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 50%;
		color: var(--color-text-secondary);
		transition: background 0.2s;
	}

	.close-thread-btn:hover {
		background: var(--color-surface-hover);
	}

	.thread-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-left: auto;
	}

	.thread-actions :global(.icon-btn.starred) {
		color: var(--color-star);
	}

	.thread-content {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 1.5rem 2rem 2rem;
	}

	.subject-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
		padding-bottom: 1.25rem;
		border-bottom: 1px solid var(--color-line);
		margin-bottom: 1rem;
	}

	.subject-row h1 {
		font-size: 1.25rem;
		font-weight: 500;
		letter-spacing: 0;
		line-height: 1.4;
		color: var(--color-text);
	}

	.thread-count {
		flex-shrink: 0;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		white-space: nowrap;
	}

	.expand-all {
		margin-bottom: 0.75rem;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		transition: color 0.2s;
	}

	.expand-all:hover {
		color: var(--color-text);
	}

	.thread-messages {
		margin-bottom: 1.5rem;
	}

	.reply-section {
		padding-top: 1.5rem;
		border-top: 1px solid var(--color-line);
	}

	.reply-to {
		margin-bottom: 0.75rem;
		font-size: 0.875rem;
		color: var(--color-text-secondary);
	}

	.reply-field {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 0.5rem;
	}

	.reply-field span {
		flex-shrink: 0;
		width: 4.5rem;
		font-size: 0.875rem;
		color: var(--color-text-secondary);
	}

	.reply-field input {
		flex: 1;
		min-width: 0;
		padding: 0.25rem 0;
		font-size: 0.875rem;
		color: var(--color-text);
		background: transparent;
		border: none;
		border-bottom: 1px solid var(--color-line);
		outline: none;
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

	.reply-prompts {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.reply-prompt {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		flex: 1;
		min-width: 7rem;
		padding: 0.875rem 1.25rem;
		border-radius: 2rem;
		font-size: 0.875rem;
		color: var(--color-text-secondary);
		background: var(--color-surface-muted);
		transition: background 0.2s;
	}

	.reply-prompt:hover {
		background: var(--color-surface-hover);
	}
</style>
