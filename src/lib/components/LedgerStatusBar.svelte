<script lang="ts">
	import type { Domain, MailboxCounts } from '#lib/types.ts';

	// Ledger's bottom strip: live counts on the left, the keyboard map on the right.
	let {
		counts,
		domains,
		activeDomainId
	}: {
		counts: MailboxCounts;
		domains: Domain[];
		activeDomainId: string | null;
	} = $props();

	const scope = $derived(
		domains.find((domain) => domain.id === activeDomainId)?.name ??
			(domains.length === 1 ? domains[0].name : 'all domains')
	);
</script>

<footer class="ledger-status" aria-label="Status and keyboard shortcuts">
	<span>INBOX <b>{counts.inbox}</b></span>
	<span>UNREAD <b>{counts.inbox_unread}</b></span>
	<span class="ledger-scope">{scope}</span>
	<span class="ledger-spacer"></span>
	<span class="ledger-keys">
		<span><kbd>j</kbd><kbd>k</kbd>move</span>
		<span><kbd>o</kbd>open</span>
		<span><kbd>r</kbd>reply</span>
		<span><kbd>s</kbd>star</span>
		<span><kbd>!</kbd>spam</span>
		<span><kbd>#</kbd>trash</span>
		<span><kbd>c</kbd>compose</span>
		<span><kbd>/</kbd>search</span>
		<span><kbd>esc</kbd>close</span>
	</span>
</footer>
