<script lang="ts">
	import MailboxSplitView from '$lib/components/MailboxSplitView.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>Spam — CloudMail</title>
</svelte:head>

<MailboxSplitView view={data.view} mailbox={data.mailbox} filters={data.filters} />

<style>
	:global(.app-main > :first-child) {
		height: 100%;
	}
</style>
