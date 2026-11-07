<script lang="ts">
	import { page } from '$app/stores';
	import MailboxSplitView from '#lib/components/MailboxSplitView.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const title = $derived(
		data.labels.find((label) => label.id === $page.params.id)?.name ?? 'Label'
	);
</script>

<svelte:head>
	<title>{title} — CloudMail</title>
</svelte:head>

<MailboxSplitView view={data.view} mailbox={data.mailbox} filters={data.filters} />

<style>
	:global(.app-main > :first-child) {
		height: 100%;
	}
</style>
