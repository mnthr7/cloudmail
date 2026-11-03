import { writable } from 'svelte/store';
import { applyTheme, readThemePreference } from './theme';

/**
 * CloudMail ships four complete looks ("skins"). The choice is saved on the
 * account (user_preferences.mail_skin) and mirrored in a cookie so signed-out pages and
 * the demo follow it too. The server stamps it on <html data-skin> before the
 * first byte reaches the browser, so there is never a flash of another skin.
 *
 * "Light / Dark / System" (theme.ts) stays a Classic-only option: the other
 * three are paper designs with their own fixed palettes.
 */
export type MailSkin = 'ledger' | 'desk' | 'notes' | 'classic';

export const DEFAULT_SKIN: MailSkin = 'ledger';
export const SKIN_COOKIE = 'qm_skin';

export const SKIN_OPTIONS: {
	value: MailSkin;
	label: string;
	blurb: string;
}[] = [
	{
		value: 'ledger',
		label: 'Ledger',
		blurb: 'Dense, one line per message, keyboard first (j/k, r, s, #, c, /).'
	},
	{
		value: 'desk',
		label: 'Desk',
		blurb: 'Quiet paper desk. Messages read like letters on a sheet.'
	},
	{
		value: 'notes',
		label: 'Notes',
		blurb: 'Working Notes: bold bars, folder drawers, highlighted unread.'
	},
	{
		value: 'classic',
		label: 'Classic',
		blurb: 'The original Gmail-style layout, with light and dark modes.'
	}
];

export function isSkin(value: unknown): value is MailSkin {
	return value === 'ledger' || value === 'desk' || value === 'notes' || value === 'classic';
}

export function parseSkin(value: unknown): MailSkin {
	return isSkin(value) ? value : DEFAULT_SKIN;
}

/** Google Fonts per skin. Only the active skin's families are requested. */
export const SKIN_FONTS: Record<MailSkin, string> = {
	ledger:
		'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Serif:ital,wght@0,400;0,500;0,600;1,400&display=swap',
	desk: 'https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400;1,6..72,500&family=Instrument+Sans:wght@400;500;600&display=swap',
	notes:
		'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,400..800&family=JetBrains+Mono:wght@400;500;600&family=Literata:ital,opsz,wght@0,7..72,400..600;1,7..72,400..600&display=swap',
	classic: 'https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap'
};

/** The reading-pane layout each skin was designed around, used until the user picks one. */
export const SKIN_DEFAULT_READING_PANE: Record<MailSkin, 'right' | 'below'> = {
	ledger: 'below',
	desk: 'right',
	notes: 'right',
	classic: 'right'
};

/**
 * Skin chosen on this page view, client only. Null until the client sets it,
 * so server renders (where module state is shared) always fall back to the
 * per-request value from layout data.
 */
export const currentSkin = writable<MailSkin | null>(null);

export function applySkin(skin: MailSkin): void {
	document.documentElement.dataset.skin = skin;
	currentSkin.set(skin);
	// Classic brings back the saved Light/Dark choice; the others force light.
	applyTheme(readThemePreference());
}

/** Switch immediately, then persist on the account (and the cookie, server side). */
export async function saveSkin(skin: MailSkin): Promise<boolean> {
	applySkin(skin);
	try {
		const res = await fetch('/api/preferences', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ skin })
		});
		return res.ok;
	} catch {
		return false;
	}
}
