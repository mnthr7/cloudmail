export type ReadingPanePreference = 'none' | 'right' | 'below';

export const READING_PANE_STORAGE_KEY = 'mail:reading-pane';
/** Matches the existing MailboxSplitView desktop breakpoint. */
export const READING_PANE_SPLIT_MIN_WIDTH = 1100;

export const READING_PANE_OPTIONS: {
	value: ReadingPanePreference;
	label: string;
	icon: string;
}[] = [
	{ value: 'none', label: 'No split', icon: 'file-list-line' },
	{ value: 'right', label: 'Right of inbox', icon: 'layout-right-2-line' },
	{ value: 'below', label: 'Below inbox', icon: 'layout-bottom-2-line' }
];

function isPreference(value: string | null): value is ReadingPanePreference {
	return value === 'none' || value === 'right' || value === 'below';
}

/**
 * Invalid or missing values fall back to the default for the active skin
 * (Ledger was designed around "below", the others around "right").
 */
export function parseReadingPanePreference(
	value: string | null,
	fallback: ReadingPanePreference = 'right'
): ReadingPanePreference {
	return isPreference(value) ? value : fallback;
}

function skinDefault(): ReadingPanePreference {
	if (typeof document === 'undefined') return 'right';
	return document.documentElement.dataset.skin === 'ledger' ? 'below' : 'right';
}

/**
 * Phones cannot show a useful split. Under the desktop breakpoint the inbox
 * always uses the existing full-screen thread, regardless of the stored choice.
 */
export function resolveReadingPaneLayout(
	preference: ReadingPanePreference,
	viewportWidth: number,
	splitMinWidth = READING_PANE_SPLIT_MIN_WIDTH
): ReadingPanePreference {
	if (viewportWidth < splitMinWidth) return 'none';
	return preference;
}

export function readReadingPanePreference(): ReadingPanePreference {
	return parseReadingPanePreference(localStorage.getItem(READING_PANE_STORAGE_KEY), skinDefault());
}

/** Stamps the preference on <html> so mailbox CSS can react without a remount. */
export function applyReadingPanePreference(preference: ReadingPanePreference): void {
	document.documentElement.dataset.readingPane = preference;
}

export function setReadingPanePreference(preference: ReadingPanePreference): void {
	localStorage.setItem(READING_PANE_STORAGE_KEY, preference);
	applyReadingPanePreference(preference);
}
