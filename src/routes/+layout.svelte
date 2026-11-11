<script lang="ts">
	import './layout.css';
	import { page } from '$app/state';
	import favicon from '#lib/assets/favicon.svg';
	import Sidebar from '#lib/components/Sidebar.svelte';
	import Topbar from '#lib/components/Topbar.svelte';
	import FloatingCompose from '#lib/components/FloatingCompose.svelte';
	import KeyboardShortcuts from '#lib/components/KeyboardShortcuts.svelte';
	import MacClipboard from '#lib/components/MacClipboard.svelte';
	import LedgerStatusBar from '#lib/components/LedgerStatusBar.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import Toaster from '#lib/components/Toaster.svelte';
	import { currentSkin, SKIN_FONTS } from '#lib/skin.ts';
	import '#lib/skins/ledger.css';
	import '#lib/skins/desk.css';
	import '#lib/skins/notes.css';
	import { watchSystemTheme } from '#lib/theme.ts';
	import { applyReadingPanePreference, readReadingPanePreference } from '#lib/reading-pane.ts';
	import type { LayoutData } from './$types';

	let { children, data }: { children: import('svelte').Snippet; data: LayoutData } = $props();

	// Onboarding runs before the user has an address, so the shell would be empty.
	const showShell = $derived(
		Boolean(data.user) && page.url.pathname !== '/onboarding' && !page.url.pathname.startsWith('/book/')
	);

	// Pages that read better centred than full-bleed.
	const NARROW = ['/compose', '/mail', '/settings'];
	const narrow = $derived(NARROW.some((path) => page.url.pathname.startsWith(path)));

	// Server picked the skin (account → cookie → Ledger); Settings can change it live.
	const skin = $derived($currentSkin ?? data.skin);
	$effect(() => {
		currentSkin.set(data.skin);
		document.documentElement.dataset.skin = data.skin;
	});

	const primaryAddress = $derived(
		data.addresses?.find((address) => address.is_default)?.address ??
			data.addresses?.[0]?.address ??
			data.user?.email ??
			''
	);

	let collapsed = $state(false);
	let mobileOpen = $state(false);
	let composeOpen = $state(false);

	// app.html already applied the theme; this keeps "System" live afterwards.
	$effect(() => watchSystemTheme());
	$effect(() => applyReadingPanePreference(readReadingPanePreference()));

	// Remember the collapsed sidebar between visits.
	$effect(() => {
		collapsed = localStorage.getItem('mail:sidebar-collapsed') === '1';
	});

	function toggleCollapsed(next: boolean) {
		localStorage.setItem('mail:sidebar-collapsed', next ? '1' : '0');
	}

	$effect(() => {
		toggleCollapsed(collapsed);
	});

	async function logout() {
		await fetch('/api/auth/login', { method: 'DELETE' });
		window.location.href = '/login';
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
	<link href={SKIN_FONTS[skin]} rel="stylesheet" />
</svelte:head>

{#if showShell}
	<div class="app-shell" data-collapsed={collapsed}>
		<Sidebar
			counts={data.counts}
			labels={data.labels}
			calendarNew={data.calendar.waiting.length + data.calendar.updates}
			domains={data.domains}
			activeDomainId={data.activeDomainId}
			isAdmin={(data.user!).is_admin}
			account={primaryAddress}
			bind:collapsed
			bind:mobileOpen
			onCompose={() => composeOpen = true}
		/>

		<div class="app-content">
			<Topbar
				userName={(data.user!).name}
				userEmail={(data.user!).email}
				addresses={data.addresses}
				onToggleNav={() => mobileOpen = !mobileOpen}
				onLogout={logout}
				onCompose={() => composeOpen = true}
			/>

			<main class="app-main" class:app-main-narrow={narrow}>
				{@render children()}
			</main>
		</div>

		{#if composeOpen}
			<FloatingCompose
				addresses={data.addresses}
				onClose={() => composeOpen = false}
			/>
		{/if}

		<!-- Phones: the paper skins keep Compose one tap away (Classic uses the drawer). -->
		{#if !composeOpen}
			<button
				type="button"
				class="fab-compose"
				onclick={() => composeOpen = true}
			><Icon name="pencil-line" size={17} /> Compose</button>
		{/if}

		<MacClipboard />

		{#if skin === 'ledger'}
			<LedgerStatusBar
				counts={data.counts}
				domains={data.domains}
				activeDomainId={data.activeDomainId}
			/>

			<KeyboardShortcuts onCompose={() => composeOpen = true} />
		{/if}
	</div>
{:else}
	{@render children()}
{/if}

<Toaster />
