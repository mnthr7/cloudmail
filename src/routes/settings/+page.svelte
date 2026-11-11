<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import Section from '#lib/components/Section.svelte';
	import AddressField from '#lib/components/AddressField.svelte';
	import RichTextEditor from '#lib/components/RichTextEditor.svelte';
	import {
		readThemePreference,
		setThemePreference,
		THEME_OPTIONS,
		type ThemePreference
	} from '#lib/theme.ts';
	import {
		readReadingPanePreference,
		setReadingPanePreference,
		READING_PANE_OPTIONS,
		type ReadingPanePreference
	} from '#lib/reading-pane.ts';
	import type { MailAddress } from '#lib/types.ts';
	import type { PageData } from './$types';
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount, untrack } from 'svelte';

	/** The page's sections, grouped, for the jump list. */
	const SETTINGS_GROUPS = [
		{
			label: 'Look and feel',
			items: [
				{ id: 'theme', title: 'Theme' },
				{ id: 'appearance', title: 'Appearance' },
				{ id: 'reading-pane', title: 'Reading pane' }
			]
		},
		{
			label: 'Addresses',
			items: [
				{ id: 'addresses', title: 'Your addresses' },
				{ id: 'domains', title: 'Connected domains' }
			]
		},
		{
			label: 'Sorting and safety',
			items: [
				{ id: 'filters', title: 'Filters' },
				{ id: 'blocked', title: 'Blocked senders' },
				{ id: 'phishing', title: 'Phishing protection' },
				{ id: 'image-senders', title: 'Trusted image senders' }
			]
		}
	];

	/** The section at the top of the screen, highlighted in the jump list. */
	let currentSection = $state('theme');
	onMount(() => {
		const sections = SETTINGS_GROUPS.flatMap((group) => group.items)
			.map((item) => document.getElementById(item.id))
			.filter((element): element is HTMLElement => !!element);
		const observer = new IntersectionObserver(
			(entries) => {
				const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
				if (visible[0]) currentSection = visible[0].target.id;
			},
			{ rootMargin: '0px 0px -70% 0px' }
		);
		for (const section of sections) observer.observe(section);
		return () => observer.disconnect();
	});
	import { CATEGORIES, type MailCategory } from '#lib/organizing/categories.ts';
	import { currentSkin, saveSkin, SKIN_OPTIONS, type MailSkin } from '#lib/skin.ts';

	let { data }: { data: PageData } = $props();

	// The preference lives in localStorage, so it can only be read on the client.
	let theme = $state<ThemePreference>('system');
	$effect(() => {
		theme = readThemePreference();
	});

	function chooseTheme(next: ThemePreference) {
		theme = next;
		setThemePreference(next);
	}

	// Mail skin: saved on the account, applied the moment it is picked.
	const skin = $derived<MailSkin>($currentSkin ?? page.data.skin as MailSkin ?? 'ledger');
	let skinSaving = $state(false);
	let skinError = $state('');

	async function chooseSkin(next: MailSkin) {
		skinSaving = true;
		skinError = '';
		const ok = await saveSkin(next);
		skinSaving = false;
		if (!ok) skinError = 'Switched for now, but it could not be saved to your account.';
		// Re-read the reading pane so a skin's default layout applies right away.
		readingPane = readReadingPanePreference();
		setReadingPanePreferenceIfUnset();
	}

	function setReadingPanePreferenceIfUnset() {
		if (localStorage.getItem('mail:reading-pane')) return;
		document.documentElement.dataset.readingPane = readReadingPanePreference();
	}

	let readingPane = $state<ReadingPanePreference>('right');
	$effect(() => {
		readingPane = readReadingPanePreference();
	});

	function chooseReadingPane(next: ReadingPanePreference) {
		readingPane = next;
		setReadingPanePreference(next);
	}

	// Server data until an edit happens, then whatever the API returned.
	let edited = $state<MailAddress[] | null>(null);
	const addresses = $derived(edited ?? data.addresses);

	let localPart = $state('');
	let domainId = $state('');
	let error = $state('');
	let busy = $state(false);

	const UNDO_OPTIONS = [5, 10, 20, 30] as const;
	let undoChoice = $state<string | null>(null);
	const undoSeconds = $derived(undoChoice ?? String(data.undoSendSeconds ?? 10));
	let undoError = $state('');
	let undoSaving = $state(false);

	// Last value the server accepted. A rejected edit puts this back in the field.
	let vtStored = $state<number | null>(null);
	const vtThreshold = $derived(String(vtStored ?? data.vtMaliciousThreshold ?? 1));
	let vtError = $state('');
	let vtSaving = $state(false);

	let imageSenderOverride = $state<string[] | null>(null);
	const imageSenderRows = $derived(imageSenderOverride ?? data.imageSenders);
	let imageSenderError = $state('');
	let imageSenderBusy = $state(false);

	type SignatureDraft = {
		id: string;
		address: string;
		html: string;
		saving: boolean;
		error: string;
	};

	function blankDraft(address: {
		id: string;
		address: string;
		signature_html?: string | null;
	}): SignatureDraft {
		return {
			id: address.id,
			address: address.address,
			html: address.signature_html ?? '',
			saving: false,
			error: ''
		};
	}

	let signatureDrafts = $state<SignatureDraft[]>(untrack(() => addresses.map(blankDraft)));

	$effect.pre(() => {
		const list = addresses;
		const byId = new Map(signatureDrafts.map((draft) => [draft.id, draft]));
		const next = list.map((address) => {
			const existing = byId.get(address.id);
			if (existing) {
				if (existing.address !== address.address) existing.address = address.address;
				return existing;
			}
			return blankDraft(address);
		});
		const same =
			next.length === signatureDrafts.length &&
			next.every((draft, index) => draft === signatureDrafts[index]);
		if (!same) signatureDrafts = next;
	});

	function messageFrom(body: unknown, fallback: string): string {
		if (
			body &&
			typeof body === 'object' &&
			'error' in body &&
			typeof body.error === 'string' &&
			body.error
		) {
			return body.error;
		}
		return fallback;
	}

	async function saveUndo(next: string) {
		if (undoSaving) return;
		undoChoice = next;
		undoSaving = true;
		undoError = '';
		try {
			const res = await fetch('/api/preferences', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ undoSendSeconds: Number(next) })
			});
			const body = await res.json().catch(() => null);
			if (!res.ok) {
				undoError = messageFrom(body, 'Could not save the undo delay');
				undoChoice = null;
			}
		} catch {
			undoError = 'Network error';
			undoChoice = null;
		} finally {
			undoSaving = false;
		}
	}

	let phishingToSpam = $state<boolean | null>(null);
	const phishingOn = $derived(phishingToSpam ?? data.phishingToSpam);
	let phishingSaving = $state(false);
	let phishingError = $state('');

	async function savePhishingToSpam(on: boolean) {
		phishingSaving = true;
		phishingError = '';
		const before = phishingOn;
		phishingToSpam = on;
		try {
			const res = await fetch('/api/preferences', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ phishingToSpam: on })
			});
			const body = await res.json().catch(() => null);
			if (!res.ok) {
				phishingToSpam = before;
				phishingError = messageFrom(body, 'Could not save the phishing setting');
				return;
			}
			if (typeof body?.phishingToSpam === 'boolean') phishingToSpam = body.phishingToSpam;
		} catch {
			phishingToSpam = before;
			phishingError = 'Network error';
		} finally {
			phishingSaving = false;
		}
	}

	async function saveThreshold(input: HTMLInputElement) {
		if (vtSaving) return;
		const next = input.value;
		const stored = vtThreshold;
		vtSaving = true;
		vtError = '';
		try {
			const res = await fetch('/api/preferences', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ vtMaliciousThreshold: Number(next) })
			});
			const body = await res.json().catch(() => null);
			if (!res.ok) {
				vtError = messageFrom(body, 'Could not save the scan threshold');
				vtStored = Number(stored);
				input.value = stored;
				return;
			}
			const saved =
				body &&
				typeof body === 'object' &&
				'vtMaliciousThreshold' in body &&
				typeof body.vtMaliciousThreshold === 'number'
					? body.vtMaliciousThreshold
					: Number(next);
			vtStored = saved;
			input.value = String(saved);
		} catch {
			vtError = 'Network error';
			vtStored = Number(stored);
			input.value = stored;
		} finally {
			vtSaving = false;
		}
	}

	async function removeImageSender(address: string) {
		if (imageSenderBusy) return;
		imageSenderBusy = true;
		imageSenderError = '';
		try {
			const res = await fetch('/api/image-senders', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ address })
			});
			const body = await res.json().catch(() => null);
			if (!res.ok) {
				imageSenderError = messageFrom(body, 'Could not remove that sender');
				return;
			}
			imageSenderOverride = (imageSenderOverride ?? data.imageSenders).filter(
				(item) => item !== address
			);
		} catch {
			imageSenderError = 'Network error';
		} finally {
			imageSenderBusy = false;
		}
	}

	async function saveAddressSignature(draft: SignatureDraft) {
		if (draft.saving) return;
		draft.saving = true;
		draft.error = '';
		try {
			const res = await fetch(`/api/addresses/${draft.id}/signature`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ html: draft.html })
			});
			const body = await res.json().catch(() => null);
			if (!res.ok) {
				draft.error = messageFrom(body, 'Could not save that signature');
				return;
			}
			if (!draft.html.trim()) draft.html = '';
			await invalidateAll();
		} catch {
			draft.error = 'Network error';
		} finally {
			draft.saving = false;
		}
	}

	$effect(() => {
		if (!domainId && data.domains[0]) {
			domainId = data.domains[0].id;
		}
	});

	const selectedDomain = $derived(data.domains.find((domain) => domain.id === domainId));

	async function addAddress(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		error = '';

		try {
			const res = await fetch('/api/addresses', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ domainId, localPart })
			});
			const body = await res.json();
			if (!res.ok) {
				error = body.error ?? 'Could not add that address';
				return;
			}
			edited = [...addresses, body.address];
			localPart = '';
		} catch {
			error = 'Network error';
		} finally {
			busy = false;
		}
	}

	async function makeDefault(id: string) {
		const res = await fetch(`/api/addresses/${id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ isDefault: true })
		});
		const body = await res.json();
		if (res.ok) edited = body.addresses;
	}

	async function remove(id: string) {
		const res = await fetch(`/api/addresses/${id}`, { method: 'DELETE' });
		const body = await res.json();
		if (!res.ok) {
			error = body.error ?? 'Could not remove that address';
			return;
		}
		edited = body.addresses;
	}

	const CATEGORY_LABELS: Record<MailCategory, string> = {
		primary: 'Primary',
		social: 'Social',
		promotions: 'Promotions',
		updates: 'Updates',
		forums: 'Forums'
	};

	const FILTER_ERROR_TEXT: Record<string, string> = {
		condition: 'Add at least one condition.',
		action: 'Add at least one action.',
		forward: 'Enter an email address to forward to.',
		category: 'Use primary, social, promotions, updates, or forums.',
		label: 'Choose one of your labels.'
	};

	type SavedFilter = PageData['filters'][number];
	type FilterForm = {
		matchFrom: string;
		matchTo: string;
		matchSubject: string;
		matchWords: string;
		matchHasAttachment: boolean;
		actionLabelId: string;
		actionSkipInbox: boolean;
		actionStar: boolean;
		actionImportant: boolean;
		actionMarkRead: boolean;
		actionTrash: boolean;
		actionCategory: string;
		actionForwardTo: string;
	};
	type ApplyPreview = { id: string; matched: number; forwards: boolean };

	let filterOverride = $state<PageData['filters'] | null>(null);
	let blockedOverride = $state<PageData['blocked'] | null>(null);
	const filterRows = $derived(filterOverride ?? data.filters);
	const blockedRows = $derived(blockedOverride ?? data.blocked);

	let formOpen = $state(false);
	let editingId = $state<string | null>(null);
	let form = $state<FilterForm>(blankForm());
	let applyAlso = $state(false);
	let preview = $state<ApplyPreview | null>(null);
	let filterError = $state('');
	let filterNotice = $state('');
	let blockedError = $state('');
	let organizingBusy = $state(false);

	const fieldsDisabled = $derived(organizingBusy || preview !== null);

	const labelOptions = $derived.by(() => {
		const labels = data.labels;
		const ids = new Set(labels.map((label) => label.id));
		const children = new Map<string | null, typeof labels>();
		for (const label of labels) {
			const parentId = label.parentId && ids.has(label.parentId) ? label.parentId : null;
			const list = children.get(parentId) ?? [];
			list.push(label);
			children.set(parentId, list);
		}
		const rows: { id: string; name: string; color: (typeof labels)[number]['color']; depth: number }[] =
			[];
		const seen = new Set<string>();
		function walk(parentId: string | null, depth: number) {
			for (const label of children.get(parentId) ?? []) {
				if (seen.has(label.id)) continue;
				seen.add(label.id);
				rows.push({ id: label.id, name: label.name, color: label.color, depth });
				walk(label.id, depth + 1);
			}
		}
		walk(null, 0);
		return rows;
	});

	const selectedLabel = $derived(
		labelOptions.find((label) => label.id === form.actionLabelId) ?? null
	);

	function blankForm(): FilterForm {
		return {
			matchFrom: '',
			matchTo: '',
			matchSubject: '',
			matchWords: '',
			matchHasAttachment: false,
			actionLabelId: '',
			actionSkipInbox: false,
			actionStar: false,
			actionImportant: false,
			actionMarkRead: false,
			actionTrash: false,
			actionCategory: '',
			actionForwardTo: ''
		};
	}

	function fromFilter(filter: SavedFilter): FilterForm {
		return {
			matchFrom: filter.matchFrom ?? '',
			matchTo: filter.matchTo ?? '',
			matchSubject: filter.matchSubject ?? '',
			matchWords: filter.matchWords ?? '',
			matchHasAttachment: filter.matchHasAttachment,
			actionLabelId: filter.actionLabelId ?? '',
			actionSkipInbox: filter.actionSkipInbox,
			actionStar: filter.actionStar,
			actionImportant: filter.actionImportant,
			actionMarkRead: filter.actionMarkRead,
			actionTrash: filter.actionTrash,
			actionCategory: filter.actionCategory ?? '',
			actionForwardTo: filter.actionForwardTo ?? ''
		};
	}

	function summary(filter: SavedFilter): string {
		const conditions: string[] = [];
		if (filter.matchFrom) conditions.push(`From ${filter.matchFrom}`);
		if (filter.matchTo) conditions.push(`To ${filter.matchTo}`);
		if (filter.matchSubject) conditions.push(`Subject ${filter.matchSubject}`);
		if (filter.matchWords) conditions.push(`Has the words ${filter.matchWords}`);
		if (filter.matchHasAttachment) conditions.push('Has attachment');
		const actions: string[] = [];
		if (filter.actionLabelId) {
			const label = data.labels.find((item) => item.id === filter.actionLabelId);
			actions.push(label ? `Label ${label.name}` : 'Label');
		}
		if (filter.actionSkipInbox) actions.push('Skip inbox');
		if (filter.actionStar) actions.push('Star');
		if (filter.actionImportant) actions.push('Important');
		if (filter.actionMarkRead) actions.push('Mark read');
		if (filter.actionTrash) actions.push('Trash');
		if (filter.actionCategory) actions.push(CATEGORY_LABELS[filter.actionCategory]);
		if (filter.actionForwardTo) actions.push(`Forward ${filter.actionForwardTo}`);
		const left = conditions.join(', ');
		const right = actions.join(', ');
		if (left && right) return `${left} → ${right}`;
		return left || right || 'Filter';
	}

	function upsertFilter(filter: SavedFilter) {
		const list = filterOverride ?? data.filters;
		const next = list.some((item) => item.id === filter.id)
			? list.map((item) => item.id === filter.id ? filter : item)
			: [...list, filter];
		filterOverride = next
			.slice()
			.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
	}

	function errorText(body: unknown, fallback: string): string {
		if (
			body &&
			typeof body === 'object' &&
			'error' in body &&
			typeof body.error === 'string' &&
			body.error
		) {
			return FILTER_ERROR_TEXT[body.error] ?? body.error;
		}
		return fallback;
	}

	async function readJson(res: Response): Promise<unknown> {
		return res.json().catch(() => null);
	}

	function readSavedFilter(body: unknown): SavedFilter | null {
		if (!body || typeof body !== 'object' || !('filter' in body)) return null;
		const filter = (body as { filter: unknown }).filter;
		if (!filter || typeof filter !== 'object') return null;
		const row = filter as SavedFilter;
		if (typeof row.id !== 'string' || typeof row.position !== 'number' || typeof row.enabled !== 'boolean') {
			return null;
		}
		return row;
	}

	function openNew() {
		if (organizingBusy) return;
		editingId = null;
		form = blankForm();
		applyAlso = false;
		preview = null;
		filterError = '';
		formOpen = true;
	}

	function openEdit(filter: SavedFilter) {
		if (organizingBusy) return;
		editingId = filter.id;
		form = fromFilter(filter);
		applyAlso = false;
		preview = null;
		filterError = '';
		formOpen = true;
	}

	function closeForm() {
		formOpen = false;
		editingId = null;
		preview = null;
		applyAlso = false;
		form = blankForm();
	}

	function payload(enabled: boolean) {
		return {
			enabled,
			matchFrom: form.matchFrom,
			matchTo: form.matchTo,
			matchSubject: form.matchSubject,
			matchWords: form.matchWords,
			matchHasAttachment: form.matchHasAttachment,
			actionLabelId: form.actionLabelId || null,
			actionSkipInbox: form.actionSkipInbox,
			actionStar: form.actionStar,
			actionImportant: form.actionImportant,
			actionMarkRead: form.actionMarkRead,
			actionTrash: form.actionTrash,
			actionCategory: form.actionCategory || null,
			actionForwardTo: form.actionForwardTo
		};
	}

	async function saveFilter(event: SubmitEvent) {
		event.preventDefault();
		if (organizingBusy || preview) return;
		organizingBusy = true;
		filterError = '';
		filterNotice = '';
		preview = null;
		try {
			const current = editingId
				? (filterOverride ?? data.filters).find((item) => item.id === editingId)
				: undefined;
			const res = await fetch(editingId ? `/api/filters/${editingId}` : '/api/filters', {
				method: editingId ? 'PATCH' : 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload(current?.enabled ?? true))
			});
			const body = await readJson(res);
			const saved = readSavedFilter(body);
			if (!res.ok || !saved) {
				filterError = errorText(body, 'Could not save that filter.');
				return;
			}
			upsertFilter(saved);
			editingId = saved.id;
			if (!applyAlso) {
				closeForm();
				return;
			}
			// Apply reads the saved row, so the dry run happens after the write.
			const previewRes = await fetch(`/api/filters/${saved.id}/apply`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ dryRun: true })
			});
			const previewBody = await readJson(previewRes);
			const matched =
				previewBody &&
				typeof previewBody === 'object' &&
				'matched' in previewBody &&
				typeof previewBody.matched === 'number'
					? previewBody.matched
					: null;
			if (!previewRes.ok || matched === null) {
				filterError = errorText(previewBody, 'Could not check matching mail.');
				return;
			}
			preview = {
				id: saved.id,
				matched,
				forwards: Boolean(saved.actionForwardTo)
			};
		} catch {
			filterError = 'Network error';
		} finally {
			organizingBusy = false;
		}
	}

	async function confirmApply() {
		if (!preview || organizingBusy) return;
		const pending = preview;
		organizingBusy = true;
		filterError = '';
		try {
			const res = await fetch(`/api/filters/${pending.id}/apply`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({})
			});
			const body = await readJson(res);
			if (!res.ok) {
				filterError = errorText(body, 'Could not apply that filter.');
				return;
			}
			const changed =
				body && typeof body === 'object' && 'changed' in body && typeof body.changed === 'number'
					? body.changed
					: null;
			const forwardFailed =
				body &&
				typeof body === 'object' &&
				'forwardFailed' in body &&
				typeof body.forwardFailed === 'number'
					? body.forwardFailed
					: null;
			preview = null;
			closeForm();
			if (changed === null || forwardFailed === null) {
				filterNotice = 'The filter ran. The result could not be read.';
			} else {
				filterNotice = `${changed} conversations changed. ${forwardFailed} forwards failed.`;
			}
		} catch {
			filterError = 'Network error';
		} finally {
			organizingBusy = false;
		}
		if (!filterError) {
			await invalidateAll().catch(() => {
				// The apply already finished. Counts refresh on the next load.
			});
		}
	}

	async function setEnabled(filter: SavedFilter, enabled: boolean): Promise<boolean> {
		if (organizingBusy) return false;
		organizingBusy = true;
		filterError = '';
		try {
			const res = await fetch(`/api/filters/${filter.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ enabled })
			});
			const body = await readJson(res);
			const saved = readSavedFilter(body);
			if (!res.ok || !saved) {
				filterError = errorText(body, 'Could not update that filter.');
				return false;
			}
			upsertFilter(saved);
			return true;
		} catch {
			filterError = 'Network error';
			return false;
		} finally {
			organizingBusy = false;
		}
	}

	async function onEnable(filter: SavedFilter, event: Event) {
		const input = event.currentTarget;
		const next = input instanceof HTMLInputElement ? input.checked : filter.enabled;
		const ok = await setEnabled(filter, next);
		if (!ok && input instanceof HTMLInputElement) input.checked = filter.enabled;
	}

	async function deleteFilter(filter: SavedFilter) {
		if (organizingBusy) return;
		organizingBusy = true;
		filterError = '';
		try {
			const res = await fetch(`/api/filters/${filter.id}`, { method: 'DELETE' });
			const body = await readJson(res);
			if (!res.ok) {
				filterError = errorText(body, 'Could not delete that filter.');
				return;
			}
			filterOverride = (filterOverride ?? data.filters).filter((item) => item.id !== filter.id);
			if (editingId === filter.id) closeForm();
		} catch {
			filterError = 'Network error';
		} finally {
			organizingBusy = false;
		}
	}

	async function unblock(address: string) {
		if (organizingBusy) return;
		organizingBusy = true;
		blockedError = '';
		try {
			const res = await fetch('/api/blocked', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ address })
			});
			const body = await readJson(res);
			if (!res.ok) {
				blockedError = errorText(body, 'Could not unblock that sender.');
				return;
			}
			blockedOverride = (blockedOverride ?? data.blocked).filter((item) => item.address !== address);
		} catch {
			blockedError = 'Network error';
		} finally {
			organizingBusy = false;
		}
	}
</script>

<svelte:head>
	<title>Settings — CloudMail</title>
</svelte:head>

<div class="settings-page">
	<h1>Settings</h1>

	<div class="settings-layout">
	<nav class="settings-nav" aria-label="Settings sections">
		{#each SETTINGS_GROUPS as group (group.label)}
			<p class="nav-group">{group.label}</p>
			{#each group.items.filter((item) => item.id !== 'appearance' || skin === 'classic') as item (item.id)}
				<a href="#{item.id}" class:current={currentSection === item.id}>{item.title}</a>
			{/each}
		{/each}
	</nav>
	<div class="settings-sections">

	<Section id="theme" title="Theme" icon="palette-line" remember="settings">
		<p class="card-hint">
			Pick how CloudMail looks. Saved to your account, so it follows you to every device.
		</p>

		<div class="skin-options" role="radiogroup" aria-label="Mail theme">
			{#each SKIN_OPTIONS as option (option.value)}
				<button
					type="button"
					role="radio"
					aria-checked={skin === option.value}
					class="theme-option skin-option"
					class:selected={skin === option.value}
					data-skin-option={option.value}
					disabled={skinSaving}
					onclick={() => chooseSkin(option.value)}
				>
					<span class="skin-preview skin-preview-{option.value}" aria-hidden="true">
						<span class="sp-rail"><i></i><i></i><i></i></span>
						<span class="sp-list"><i></i><i></i><i></i><i></i></span>
						<span class="sp-pane"><b></b><i></i><i></i></span>
					</span>
					<span class="theme-label">
						{option.label}
						{#if option.value === 'ledger'}<span class="skin-default">default</span>{/if}
					</span>
					<span class="skin-blurb">{option.blurb}</span>
					{#if skin === option.value}
						<span class="theme-check"><Icon name="check-line" size={14} /></span>
					{/if}
				</button>
			{/each}
		</div>
		{#if skinError}<p class="card-hint skin-error">{skinError}</p>{/if}
	</Section>

	{#if skin === 'classic'}
		<Section id="appearance" title="Appearance" icon="contrast-2-line" remember="settings">
			<p class="card-hint">Choose how Mail looks. System follows your device setting.</p>

		<div class="theme-options" role="radiogroup" aria-label="Theme">
				{#each THEME_OPTIONS as option (option.value)}
					<button
						type="button"
						role="radio"
						aria-checked={theme === option.value}
						class="theme-option"
						class:selected={theme === option.value}
						onclick={() => chooseTheme(option.value)}
					>
						<span class="theme-preview theme-preview-{option.value}">
							<span class="preview-bar"></span>
							<span class="preview-line"></span>
							<span class="preview-line short"></span>
						</span>
						<span class="theme-label">
							<Icon name={option.icon} size={15} />
							{option.label}
						</span>
						{#if theme === option.value}
							<span class="theme-check"><Icon name="check-line" size={14} /></span>
						{/if}
					</button>
				{/each}
			</div>
		</Section>
	{/if}

	<Section id="reading-pane" title="Reading pane" icon="layout-right-2-line" remember="settings">
		<p class="card-hint">
			Choose how the inbox and a conversation share the window. On phones the list stays full
			width and a message opens as its own screen.
		</p>

		<div class="theme-options" role="radiogroup" aria-label="Reading pane">
			{#each READING_PANE_OPTIONS as option (option.value)}
				<button
					type="button"
					role="radio"
					aria-checked={readingPane === option.value}
					class="theme-option"
					class:selected={readingPane === option.value}
					onclick={() => chooseReadingPane(option.value)}
				>
					<span class="pane-preview pane-preview-{option.value}" aria-hidden="true">
						<span class="pane-list">
							<span></span>
							<span></span>
							<span></span>
						</span>
						{#if option.value !== 'none'}
							<span class="pane-read"></span>
						{/if}
					</span>
					<span class="theme-label">
						<Icon name={option.icon} size={15} />
						{option.label}
					</span>
					{#if readingPane === option.value}
						<span class="theme-check"><Icon name="check-line" size={14} /></span>
					{/if}
				</button>
			{/each}
		</div>
	</Section>

	<Section id="addresses" title="Your addresses" icon="at-line" remember="settings">
		<p class="card-hint">
			Mail sent to any of these lands in your inbox. The default is what new messages are sent
			from. Each address can keep its own signature.
		</p>

		<label class="field undo-field">
			<span>Undo send</span>
			<select
				class="filter-input undo-select"
				value={undoSeconds}
				onchange={(event) => {
					const select = event.currentTarget;
					if (select instanceof HTMLSelectElement) saveUndo(select.value);
				}}
				disabled={undoSaving}
			>
				{#each UNDO_OPTIONS as seconds (seconds)}
					<option value={String(seconds)}>{seconds} seconds</option>
				{/each}
			</select>
		</label>
		{#if undoError}<p class="error" role="alert">{undoError}</p>{/if}

		<label class="field undo-field">
			<span>Block when at least this many engines say malicious.</span>
			<input
				class="filter-input"
				type="number"
				inputmode="numeric"
				value={vtThreshold}
				onchange={(event) => {
					const input = event.currentTarget;
					if (input instanceof HTMLInputElement) saveThreshold(input);
				}}
				disabled={vtSaving}
			/>
		</label>
		{#if vtError}<p class="error" role="alert">{vtError}</p>{/if}
		<p class="card-hint">
			{data.virusTotalConfigured
				? 'Inbound attachments are sent to VirusTotal and added to its public dataset.'
				: 'Scanning is not configured.'}
		</p>

		<ul class="address-list">
			{#each addresses as address (address.id)}
				<li class="address-row address-block">
					<div class="address-head">
						<div class="min-w-0 flex-1">
							<p class="address-value">{address.address}</p>
							<p class="address-domain">{address.domain_name}</p>
						</div>

						{#if address.is_default}
							<span class="badge">Default</span>
						{:else}
							<button type="button" class="btn-ghost text-xs" onclick={() => makeDefault(address.id)}>
								Make default
							</button>
						{/if}

						{#if addresses.length > 1}
							<button
								type="button"
								class="icon-btn"
								aria-label="Remove {address.address}"
								onclick={() => remove(address.id)}
							>
								<Icon name="delete-bin-line" size={15} />
							</button>
						{/if}
					</div>

					{#each signatureDrafts.filter((item) => item.id === address.id) as draft (draft.id)}
						<div class="signature-editor">
							<p class="signature-label">Signature</p>
							<RichTextEditor
								bind:html={draft.html}
								minHeight={140}
								placeholder="Signature"
							/>
							<div class="form-actions">
								<button
									type="button"
									class="btn-primary"
									disabled={draft.saving}
									onclick={() => saveAddressSignature(draft)}
								>
									{draft.saving ? 'Saving…' : 'Save signature'}
								</button>
							</div>
							{#if draft.error}<p class="error" role="alert">{draft.error}</p>{/if}
						</div>
					{/each}
				</li>
			{/each}
		</ul>

		<form class="add-form" onsubmit={addAddress}>
			<div class="add-field">
				<AddressField
					bind:localPart
					bind:domainId
					domains={data.domains}
					placeholder="another"
					label="Add an address"
				/>
			</div>
			<button type="submit" class="btn-primary" disabled={busy || !localPart.trim()}>
				{busy ? 'Adding…' : 'Add'}
			</button>
		</form>

		{#if selectedDomain && !selectedDomain.receiving_enabled}
			<p class="hint">
				<Icon name="information-line" size={14} />
				Receiving isn't enabled on {selectedDomain.name} — this address can send but won't
				receive.
			</p>
		{/if}

		{#if error}<p class="error">{error}</p>{/if}
	</Section>

	<Section id="domains" title="Connected domains" icon="global-line" remember="settings">
		<ul class="domain-list">
			{#each data.domains as domain (domain.id)}
				<li class="domain-row">
					<span class="domain-name">{domain.name}</span>
					<span class="caps">
						<span class="chip" class:chip-on={domain.sending_enabled}>send</span>
						<span class="chip" class:chip-on={domain.receiving_enabled}>receive</span>
						<span class="chip" class:chip-ok={domain.status === 'verified'}>{domain.status}</span>
					</span>
				</li>
			{/each}
		</ul>
	</Section>

	<Section id="filters" title="Filters" icon="filter-3-line" remember="settings">
		<p class="card-hint">
			Enabled filters run on new mail. Applying one to mail already filed waits until you confirm.
			Running that again sends another forward copy.
		</p>

		{#if filterError}
			<p class="error" role="alert">{filterError}</p>
		{/if}

		{#if filterNotice}
			<p class="card-hint" role="status">{filterNotice}</p>
		{/if}

		<button
			type="button"
			class="btn-ghost filter-new"
			onclick={openNew}
			disabled={organizingBusy || preview !== null}
		>
			<Icon name="add-line" size={15} />
			New filter
		</button>

		{#if formOpen}
			<form class="filter-form" onsubmit={saveFilter}>
				<fieldset disabled={fieldsDisabled}>
					<legend>Conditions</legend>
					<label class="field">
						<span>From</span>
						<input class="filter-input" bind:value={form.matchFrom} autocomplete="off" />
					</label>
					<label class="field">
						<span>To</span>
						<input class="filter-input" bind:value={form.matchTo} autocomplete="off" />
					</label>
					<label class="field">
						<span>Subject</span>
						<input class="filter-input" bind:value={form.matchSubject} autocomplete="off" />
					</label>
					<label class="field">
						<span>Has the words</span>
						<input class="filter-input" bind:value={form.matchWords} autocomplete="off" />
					</label>
					<label class="check-row">
						<input type="checkbox" bind:checked={form.matchHasAttachment} />
						Has attachment
					</label>
				</fieldset>

				<fieldset disabled={fieldsDisabled}>
					<legend>Actions</legend>
					<label class="field">
						<span>Label</span>
						<span class="label-select">
							{#if selectedLabel}
								<span class="filter-dot" data-color={selectedLabel.color} aria-hidden="true"></span>
							{/if}
							<select class="filter-input" bind:value={form.actionLabelId}>
								<option value="">None</option>
								{#each labelOptions as label (label.id)}
									<option value={label.id}>{('— ').repeat(label.depth)}{label.name}</option>
								{/each}
								{#if form.actionLabelId && !labelOptions.some((label) => label.id === form.actionLabelId)}
									<option value={form.actionLabelId}>Current label</option>
								{/if}
							</select>
						</span>
					</label>
					<label class="check-row">
						<input type="checkbox" bind:checked={form.actionSkipInbox} />
						Skip inbox
					</label>
					<label class="check-row">
						<input type="checkbox" bind:checked={form.actionStar} />
						Star
					</label>
					<label class="check-row">
						<input type="checkbox" bind:checked={form.actionImportant} />
						Important
					</label>
					<label class="check-row">
						<input type="checkbox" bind:checked={form.actionMarkRead} />
						Mark read
					</label>
					<label class="check-row">
						<input type="checkbox" bind:checked={form.actionTrash} />
						Trash
					</label>
					<label class="field">
						<span>Category</span>
						<select class="filter-input" bind:value={form.actionCategory}>
							<option value="">None</option>
							{#each CATEGORIES as category (category)}
								<option value={category}>{CATEGORY_LABELS[category]}</option>
							{/each}
						</select>
					</label>
					<label class="field">
						<span>Forward address</span>
						<input class="filter-input" bind:value={form.actionForwardTo} autocomplete="off" />
					</label>
				</fieldset>

				<label class="check-row apply-row">
					<input type="checkbox" bind:checked={applyAlso} disabled={fieldsDisabled} />
					Also apply to matching mail
				</label>

				{#if preview}
					<div class="apply-preview" role="status">
						<p>This matches {preview.matched} conversations</p>
						{#if preview.forwards}
							<p>{preview.matched} conversations will be forwarded</p>
						{/if}
					</div>
					<div class="form-actions">
						<button type="button" class="btn-primary" onclick={confirmApply} disabled={organizingBusy}>
							{organizingBusy ? 'Applying…' : 'Confirm'}
						</button>
						<button type="button" class="btn-ghost" onclick={closeForm} disabled={organizingBusy}>
							Don't apply
						</button>
					</div>
				{:else}
					<div class="form-actions">
						<button type="submit" class="btn-primary" disabled={organizingBusy}>
							{organizingBusy ? 'Saving…' : 'Save'}
						</button>
						<button type="button" class="btn-ghost" onclick={closeForm} disabled={organizingBusy}>
							Cancel
						</button>
					</div>
				{/if}
			</form>
		{/if}

		{#if filterRows.length === 0}
			<p class="card-hint empty-note">No filters yet.</p>
		{:else}
			<ul class="filter-list">
				{#each filterRows as filter (filter.id)}
					<li class="filter-row" class:filter-off={!filter.enabled}>
						<label class="enable">
							<input
								type="checkbox"
								checked={filter.enabled}
								disabled={organizingBusy || preview !== null}
								aria-label={`Enabled: ${summary(filter)}`}
								onchange={(event) => onEnable(filter, event)}
							/>
						</label>
						<p class="filter-summary">{summary(filter)}</p>
						<button
							type="button"
							class="btn-ghost text-xs"
							onclick={() => openEdit(filter)}
							disabled={organizingBusy || preview !== null}
						>
							Edit
						</button>
						<button
							type="button"
							class="btn-ghost text-xs"
							onclick={() => deleteFilter(filter)}
							disabled={organizingBusy || preview !== null}
						>
							Delete
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</Section>

	<Section id="blocked" title="Blocked senders" icon="forbid-line" remember="settings">
		<p class="card-hint">New mail from these addresses goes to Spam. Unblock removes that address.</p>

		{#if blockedError}<p class="error" role="alert">{blockedError}</p>{/if}

		{#if blockedRows.length === 0}
			<p class="card-hint empty-note">No blocked senders.</p>
		{:else}
			<ul class="filter-list">
				{#each blockedRows as sender (sender.address)}
					<li class="filter-row">
						<p class="filter-summary">{sender.address}</p>
						<button
							type="button"
							class="btn-ghost text-xs"
							onclick={() => unblock(sender.address)}
							disabled={organizingBusy}
						>
							Unblock
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</Section>

	<Section id="phishing" title="Phishing protection" icon="spam-2-line" remember="settings">
		<p class="card-hint">
			New mail is checked when it arrives: whether the sender's domain vouches for it, lookalike
			domains, names that pretend to be a brand or someone on your team, and first-time senders
			asking for money or logins. Anything suspicious gets a warning above the message and a marker
			in the inbox. Agents never act on mail that looks like phishing.
		</p>
		<label class="check-row">
			<input
				type="checkbox"
				checked={phishingOn}
				disabled={phishingSaving}
				onchange={(event) => savePhishingToSpam(event.currentTarget.checked)}
			/>
			Move mail that looks like phishing straight to Spam
		</label>
		<p class="card-hint">Only the strongest warnings move. "Be careful" mail stays in the inbox, flagged.</p>
		{#if phishingError}<p class="error" role="alert">{phishingError}</p>{/if}
	</Section>

	<Section id="image-senders" title="Trusted image senders" icon="image-line" remember="settings">
		<p class="card-hint">Remote images load from these addresses. Remove takes that address off the list.</p>

		{#if imageSenderError}<p class="error" role="alert">{imageSenderError}</p>{/if}

		{#if imageSenderRows.length === 0}
			<p class="card-hint empty-note">No trusted image senders.</p>
		{:else}
			<ul class="filter-list">
				{#each imageSenderRows as address (address)}
					<li class="filter-row">
						<p class="filter-summary">{address}</p>
						<button
							type="button"
							class="btn-ghost text-xs"
							onclick={() => removeImageSender(address)}
							disabled={imageSenderBusy}
						>
							Remove
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</Section>
	</div>
	</div>
</div>

<style>
	.settings-page {
		max-width: 64rem;
	}

	.settings-layout {
		display: grid;
		gap: 1.5rem;
	}

	.settings-sections {
		min-width: 0;
		max-width: 48rem;
	}

	.settings-sections > :global(.fold:first-child) {
		margin-top: 0;
	}

	.settings-nav {
		display: flex;
		gap: 0.375rem;
		overflow-x: auto;
		padding-bottom: 0.25rem;
		scrollbar-width: none;
	}

	.settings-nav a {
		flex: none;
		padding: 0.375rem 0.75rem;
		border-radius: 999px;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		text-decoration: none;
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.settings-nav a:hover,
	.settings-nav a.current {
		color: var(--color-text);
		background: var(--color-surface-muted);
	}

	.nav-group {
		display: none;
	}

	@media (min-width: 1024px) {
		.settings-layout {
			grid-template-columns: 11rem minmax(0, 1fr);
			align-items: start;
		}

		.settings-nav {
			position: sticky;
			top: 1rem;
			flex-direction: column;
			gap: 0.125rem;
			overflow: visible;
		}

		.settings-nav a {
			padding: 0.375rem 0.625rem;
			border-radius: 0.5rem;
			box-shadow: none;
		}

		.nav-group {
			display: block;
			margin: 0.875rem 0 0.25rem 0.625rem;
			font-size: 0.6875rem;
			font-weight: 600;
			letter-spacing: 0.04em;
			text-transform: uppercase;
			color: var(--color-text-secondary);
		}

		.nav-group:first-child {
			margin-top: 0;
		}
	}

	.settings-page h1 {
		font-size: 1.5rem;
		font-weight: 400;
		letter-spacing: 0;
		margin-bottom: 0.5rem;
	}

	.card {
		margin-top: 1.5rem;
		padding: 2rem;
	}


	.card-hint {
		margin-top: 0.5rem;
		font-size: 0.875rem;
		line-height: 1.6;
		color: var(--color-text-secondary);
	}

	.theme-options {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.625rem;
		margin-top: 1rem;
	}

	@media (max-width: 640px) {
		.theme-options {
			grid-template-columns: 1fr;
		}
	}

	.theme-option {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 0.875rem;
		border-radius: 0.5rem;
		text-align: left;
		box-shadow: inset 0 0 0 1px var(--color-line);
		transition: box-shadow 0.2s, background 0.2s;
	}

	.theme-option:hover {
		background: var(--color-surface-hover);
	}

	.theme-option.selected {
		box-shadow: inset 0 0 0 2px var(--color-link);
	}

	/* A miniature of the app in that theme — fixed colours, not theme tokens. */
	.theme-preview {
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 0.3125rem;
		height: 3.25rem;
		padding: 0.5rem;
		border-radius: 0.5rem;
		overflow: hidden;
	}

	.preview-bar {
		width: 60%;
		height: 0.375rem;
		border-radius: 9999px;
	}

	.preview-line {
		width: 100%;
		height: 0.25rem;
		border-radius: 9999px;
		opacity: 0.55;
	}

	.preview-line.short {
		width: 70%;
	}

	.theme-preview-light {
		background: #f5f5f5;
		box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.06);
	}

	.theme-preview-light .preview-bar,
	.theme-preview-light .preview-line {
		background: #0a0a0a;
	}

	.theme-preview-dark {
		background: #17171a;
		box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.1);
	}

	.theme-preview-dark .preview-bar,
	.theme-preview-dark .preview-line {
		background: #f4f4f5;
	}

	.theme-preview-system {
		background: linear-gradient(120deg, #f5f5f5 0 50%, #17171a 50% 100%);
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.theme-preview-system .preview-bar,
	.theme-preview-system .preview-line {
		background: linear-gradient(120deg, #0a0a0a 0 50%, #f4f4f5 50% 100%);
	}

	.theme-label {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--color-text-secondary);
	}

	.theme-option.selected .theme-label {
		color: var(--color-text);
	}

	.pane-preview {
		display: flex;
		height: 3.25rem;
		padding: 0.375rem;
		border-radius: 0.5rem;
		overflow: hidden;
		background: var(--color-surface-muted);
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.pane-preview-none {
		flex-direction: column;
	}

	.pane-preview-right {
		flex-direction: row;
		gap: 0.25rem;
	}

	.pane-preview-below {
		flex-direction: column;
		gap: 0.25rem;
	}

	.pane-list {
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 0.25rem;
		min-width: 0;
	}

	.pane-preview-none .pane-list,
	.pane-preview-below .pane-list {
		flex: 1;
	}

	.pane-preview-right .pane-list {
		flex: 0 0 38%;
	}

	.pane-list span {
		display: block;
		height: 0.25rem;
		border-radius: 9999px;
		background: var(--color-text-secondary);
		opacity: 0.55;
	}

	.pane-list span:first-child {
		width: 70%;
		opacity: 0.85;
	}

	.pane-list span:last-child {
		width: 55%;
	}

	.pane-read {
		flex: 1;
		min-width: 0;
		min-height: 0;
		border-radius: 0.25rem;
		background: var(--color-surface);
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.skin-options {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 0.625rem;
		margin-top: 1rem;
	}

	@media (max-width: 760px) {
		.skin-options {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	.skin-option {
		gap: 0.5rem;
	}

	.skin-option:disabled {
		cursor: progress;
	}

	.skin-blurb {
		font-size: 0.75rem;
		line-height: 1.4;
		color: var(--color-text-secondary);
	}

	.skin-default {
		margin-left: 0.25rem;
		padding: 0 0.3rem;
		border: 1px solid currentColor;
		border-radius: 0.2rem;
		font-size: 0.625rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	.skin-error {
		color: var(--color-danger);
	}

	/* Miniatures with each skin's own fixed colours, not the live tokens. */
	.skin-preview {
		display: grid;
		grid-template-columns: 22% 38% 1fr;
		height: 4.25rem;
		border-radius: 0.375rem;
		overflow: hidden;
		box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.08);
	}

	.skin-preview > span {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.4rem 0.3rem;
		min-width: 0;
	}

	.skin-preview i,
	.skin-preview b {
		display: block;
		height: 0.2rem;
		border-radius: 1px;
	}

	.skin-preview b {
		height: 0.35rem;
		width: 70%;
	}

	.sp-pane i:last-child,
	.sp-list i:nth-child(2n) {
		width: 70%;
	}

	.skin-preview-ledger {
		background: #f2ede2;
	}
	.skin-preview-ledger .sp-rail {
		background: #1d1914;
	}
	.skin-preview-ledger .sp-rail i {
		background: #8e846f;
	}
	.skin-preview-ledger .sp-rail i:first-child {
		background: #e2a043;
	}
	.skin-preview-ledger .sp-list {
		background: #faf7f0;
		gap: 0.15rem;
	}
	.skin-preview-ledger .sp-list i {
		background: #3b352b;
		height: 0.15rem;
	}
	.skin-preview-ledger .sp-pane b,
	.skin-preview-ledger .sp-pane i {
		background: #1e1a14;
	}

	.skin-preview-desk {
		background: #eae4d7;
	}
	.skin-preview-desk .sp-rail {
		background: #efeae0;
	}
	.skin-preview-desk .sp-rail i {
		background: #7a7366;
	}
	.skin-preview-desk .sp-rail i:first-child {
		background: #8a1c1c;
	}
	.skin-preview-desk .sp-list {
		background: #f7f3ea;
	}
	.skin-preview-desk .sp-list i {
		background: #3a362e;
	}
	.skin-preview-desk .sp-pane {
		margin: 0.35rem;
		background: #fffdf8;
		box-shadow: 0 2px 6px rgba(60, 45, 20, 0.2);
	}
	.skin-preview-desk .sp-pane b,
	.skin-preview-desk .sp-pane i {
		background: #1c1a16;
	}

	.skin-preview-notes {
		background: #ece8df;
	}
	.skin-preview-notes .sp-rail {
		background: #141414;
	}
	.skin-preview-notes .sp-rail i {
		background: #ece8df;
	}
	.skin-preview-notes .sp-rail i:first-child {
		background: #f3e37a;
	}
	.skin-preview-notes .sp-list {
		border-right: 1.5px solid #141414;
	}
	.skin-preview-notes .sp-list i {
		background: #141414;
	}
	.skin-preview-notes .sp-list i:first-child {
		background: #f3e37a;
		height: 0.3rem;
	}
	.skin-preview-notes .sp-pane {
		margin: 0.3rem;
		background: #fffdf7;
		border: 1.5px solid #141414;
		box-shadow: 2px 2px 0 #141414;
		background-image: linear-gradient(90deg, transparent 18%, #d9503f 18%, #d9503f 21%, transparent 21%);
	}
	.skin-preview-notes .sp-pane b,
	.skin-preview-notes .sp-pane i {
		background: #141414;
		margin-left: 28%;
	}

	.skin-preview-classic {
		background: #f5f5f5;
	}
	.skin-preview-classic .sp-rail {
		background: #ffffff;
	}
	.skin-preview-classic .sp-rail i {
		background: #5f6368;
	}
	.skin-preview-classic .sp-rail i:first-child {
		background: #c5221f;
		height: 0.35rem;
		border-radius: 0.2rem;
	}
	.skin-preview-classic .sp-list {
		background: #ffffff;
		border-left: 1px solid #e8eaed;
	}
	.skin-preview-classic .sp-list i {
		background: #202124;
		opacity: 0.6;
	}
	.skin-preview-classic .sp-pane {
		background: #ffffff;
		border-left: 1px solid #e8eaed;
	}
	.skin-preview-classic .sp-pane b {
		background: #1a73e8;
	}
	.skin-preview-classic .sp-pane i {
		background: #5f6368;
		opacity: 0.6;
	}

	.theme-check {
		position: absolute;
		top: 0.625rem;
		right: 0.625rem;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.25rem;
		height: 1.25rem;
		border-radius: 50%;
		color: var(--color-on-accent);
		background: var(--color-link);
	}

	.address-list {
		margin-top: 1.25rem;
	}

	.address-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 1rem 0;
	}

	.address-block {
		flex-direction: column;
		align-items: stretch;
	}

	.address-head {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
	}

	.undo-field {
		max-width: 16rem;
	}

	.undo-select {
		margin-top: 0;
	}

	.signature-editor {
		margin-top: 0.75rem;
	}

	.signature-label {
		margin-bottom: 0.375rem;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.address-row + .address-row {
		box-shadow: inset 0 1px 0 var(--color-line);
	}

	.address-value {
		font-size: 0.875rem;
		font-weight: 400;
		color: var(--color-text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.address-domain {
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.badge {
		padding: 0.25rem 0.625rem;
		border-radius: 1rem;
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--color-text-secondary);
		background: var(--color-surface-hover);
	}

	.add-form {
		display: flex;
		align-items: flex-end;
		gap: 0.5rem;
		margin-top: 1.25rem;
	}

	.add-field {
		flex: 1;
		min-width: 0;
	}

	.domain-list {
		margin-top: 1rem;
	}

	.domain-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.625rem 0;
	}

	.domain-row + .domain-row {
		box-shadow: inset 0 1px 0 var(--color-line);
	}

	.domain-name {
		font-size: 0.875rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.caps {
		display: flex;
		gap: 0.3rem;
		flex-shrink: 0;
	}

	.chip {
		padding: 0.125rem 0.5rem;
		border-radius: 1rem;
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--color-text-secondary);
		background: var(--color-surface-hover);
	}

	.chip-on {
		color: var(--color-text);
	}

	.chip-ok {
		color: var(--tone-good-fg);
		background: var(--tone-good-bg);
	}

	.hint {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		margin-top: 1rem;
		font-size: 0.8125rem;
		line-height: 1.6;
		color: var(--color-text-secondary);
	}

	.error {
		margin-top: 1rem;
		font-size: 0.875rem;
		color: var(--color-danger);
	}

	.filter-new {
		margin-top: 1rem;
	}

	.filter-form {
		margin-top: 1rem;
		padding-top: 0.25rem;
	}

	.filter-form fieldset {
		margin: 1rem 0 0;
		padding: 0;
		border: 0;
	}

	.filter-form legend {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--color-text);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin-top: 0.75rem;
	}

	.field > span {
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.filter-input {
		width: 100%;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--color-line);
		border-radius: 0.5rem;
		background: var(--color-bg);
		color: var(--color-text);
		font-size: 0.875rem;
	}

	.filter-input:disabled {
		opacity: 0.7;
	}

	.label-select {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.label-select .filter-input {
		flex: 1;
		min-width: 0;
	}

	.filter-dot {
		flex-shrink: 0;
		width: 0.625rem;
		height: 0.625rem;
		border-radius: 50%;
	}

	.filter-dot[data-color="slate"] {
		background: #5f6368;
	}

	.filter-dot[data-color="red"] {
		background: #d93025;
	}

	.filter-dot[data-color="orange"] {
		background: #e37400;
	}

	.filter-dot[data-color="amber"] {
		background: #f9ab00;
	}

	.filter-dot[data-color="green"] {
		background: #188038;
	}

	.filter-dot[data-color="blue"] {
		background: #1a73e8;
	}

	.filter-dot[data-color="violet"] {
		background: #9334e6;
	}

	.filter-dot[data-color="pink"] {
		background: #d01884;
	}

	.check-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.75rem;
		font-size: 0.875rem;
		color: var(--color-text);
	}

	.apply-row {
		margin-top: 1.25rem;
	}

	.apply-preview {
		margin-top: 1rem;
		font-size: 0.875rem;
		line-height: 1.6;
		color: var(--color-text);
	}

	.form-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 1rem;
	}

	.filter-list {
		margin-top: 0.5rem;
	}

	.filter-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.875rem 0;
	}

	.filter-row + .filter-row {
		box-shadow: inset 0 1px 0 var(--color-line);
	}

	.filter-off .filter-summary {
		color: var(--color-text-secondary);
	}

	.enable {
		display: flex;
		flex-shrink: 0;
	}

	.filter-summary {
		flex: 1;
		min-width: 0;
		font-size: 0.875rem;
		line-height: 1.5;
		overflow-wrap: anywhere;
	}

	.empty-note {
		margin-top: 1rem;
	}
</style>
