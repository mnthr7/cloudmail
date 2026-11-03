<script lang="ts">
	import EmailBody from './EmailBody.svelte';
	import { MAX_MARKDOWN_PREVIEW_BYTES } from '$lib/constants';
	import { attachmentHref } from '$lib/utils/attachments';
	import { renderMarkdown } from '$lib/utils/markdown';
	import type { EmailAttachmentMeta } from '$lib/types';

	let {
		emailId,
		file
	}: {
		emailId: string;
		file: EmailAttachmentMeta;
	} = $props();

	let html = $state<string | null>(null);
	let failed = $state(false);

	const tooLarge = $derived(file.size_bytes > MAX_MARKDOWN_PREVIEW_BYTES);

	$effect(() => {
		if (tooLarge) return;

		const href = attachmentHref(emailId, file.id);
		let cancelled = false;
		html = null;
		failed = false;

		fetch(href)
			.then(async (response) => {
				if (!response.ok) throw new Error('Failed to load attachment');
				const text = await response.text();
				if (!cancelled) html = renderMarkdown(text);
			})
			.catch(() => {
				if (!cancelled) failed = true;
			});

		return () => {
			cancelled = true;
		};
	});
</script>

{#if html}
	<div class="preview">
		<p class="label">{file.filename}</p>
		<EmailBody {html} rich={false} foldQuotes={false} />
	</div>
{:else if !failed && !tooLarge}
	<p class="loading">Loading preview…</p>
{/if}

<style>
	.preview {
		overflow: hidden;
		margin-bottom: 0.75rem;
		padding: 0.75rem 0.875rem 0.5rem;
		border-radius: 0.75rem;
		background: var(--color-surface-muted);
		box-shadow: var(--shadow-xs);
	}

	.label {
		margin-bottom: 0.5rem;
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--color-text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.loading {
		margin-bottom: 0.75rem;
		font-size: 0.75rem;
		color: var(--color-muted);
	}
</style>
