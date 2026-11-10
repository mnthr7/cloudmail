import { json, type RequestHandler } from '@sveltejs/kit';
import {
	readUndoSendSeconds,
	readVtThreshold,
	setUserMailSkin,
	setUserPriorityInbox,
	setUserUndoSendSeconds,
	setUserVtThreshold
} from '#lib/server/auth.ts';
import { DEMO_USER } from '#lib/server/demo.ts';
import { readPhishingToSpam, setPhishingToSpam } from '#lib/server/phishing-check.ts';
import { parseThreshold } from '#lib/security/verdict.ts';
import { SKIN_COOKIE, isSkin } from '#lib/skin.ts';
import { parseUndoSeconds, type UndoSeconds } from '#lib/writing/timing.ts';

const YEAR_SECONDS = 365 * 24 * 60 * 60;

/** Per-account UI preferences: mail skin, Priority Inbox, Undo Send, and the scan threshold. */
export const PATCH: RequestHandler = async ({ request, locals, platform, cookies }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const body = (await request.json().catch(() => null)) as {
		skin?: unknown;
		priorityInbox?: unknown;
		undoSendSeconds?: unknown;
		vtMaliciousThreshold?: unknown;
		phishingToSpam?: unknown;
	} | null;

	const hasSkin = Boolean(body && Object.prototype.hasOwnProperty.call(body, 'skin'));
	const hasPriority = Boolean(body && Object.prototype.hasOwnProperty.call(body, 'priorityInbox'));
	const hasUndo = Boolean(body && Object.prototype.hasOwnProperty.call(body, 'undoSendSeconds'));
	const hasThreshold = Boolean(
		body && Object.prototype.hasOwnProperty.call(body, 'vtMaliciousThreshold')
	);

	const hasPhishing = Boolean(body && Object.prototype.hasOwnProperty.call(body, 'phishingToSpam'));

	if (!hasSkin && !hasPriority && !hasUndo && !hasThreshold && !hasPhishing) {
		return json({ error: 'skin must be ledger, desk, notes or classic' }, { status: 400 });
	}
	if (hasSkin && !isSkin(body?.skin)) {
		return json({ error: 'skin must be ledger, desk, notes or classic' }, { status: 400 });
	}
	if (hasPriority && typeof body?.priorityInbox !== 'boolean') {
		return json({ error: 'priorityInbox must be a boolean' }, { status: 400 });
	}

	let undoSeconds: UndoSeconds | null = null;
	if (hasUndo) {
		undoSeconds = parseUndoSeconds(body?.undoSendSeconds);
		if (!undoSeconds) {
			return json({ error: 'undoSendSeconds' }, { status: 400 });
		}
		if (locals.user.id === DEMO_USER.id) {
			return json({ error: 'Demo mode is read-only' }, { status: 403 });
		}
	}

	let vtThreshold: number | null = null;
	if (hasThreshold) {
		vtThreshold = parseThreshold(body?.vtMaliciousThreshold);
		if (vtThreshold === null) {
			return json({ error: 'vtMaliciousThreshold' }, { status: 400 });
		}
		if (locals.user.id === DEMO_USER.id) {
			return json({ error: 'Demo mode is read-only' }, { status: 403 });
		}
	}

	const db = platform?.env.DB;
	let saved: 'account' | 'browser' = 'browser';
	let priorityInbox: boolean | undefined;
	let undoSendSeconds: UndoSeconds | undefined;
	let vtMaliciousThreshold: number | undefined;

	if (undoSeconds) {
		if (!db) return json({ error: 'Unauthorized' }, { status: 401 });
		try {
			await setUserUndoSendSeconds(db, locals.user.id, undoSeconds);
			undoSendSeconds = await readUndoSendSeconds(db, locals.user.id);
			saved = 'account';
		} catch (err) {
			console.error('saving undo send delay failed', err);
			return json({ error: 'Could not save undo send delay' }, { status: 500 });
		}
	}

	if (vtThreshold !== null) {
		if (!db) return json({ error: 'Unauthorized' }, { status: 401 });
		try {
			await setUserVtThreshold(db, locals.user.id, vtThreshold);
			vtMaliciousThreshold = await readVtThreshold(db, locals.user.id);
			saved = 'account';
		} catch (err) {
			console.error('saving scan threshold failed', err);
			return json({ error: 'Could not save scan threshold' }, { status: 500 });
		}
	}

	let phishingToSpam: boolean | undefined;
	if (hasPhishing) {
		if (typeof body?.phishingToSpam !== 'boolean') {
			return json({ error: 'phishingToSpam must be a boolean' }, { status: 400 });
		}
		if (locals.user.id === DEMO_USER.id) {
			return json({ error: 'Demo mode is read-only' }, { status: 403 });
		}
		if (!db) return json({ error: 'Unauthorized' }, { status: 401 });
		try {
			await setPhishingToSpam(db, locals.user.id, body.phishingToSpam);
			phishingToSpam = await readPhishingToSpam(db, locals.user.id);
			saved = 'account';
		} catch (err) {
			console.error('saving phishing setting failed', err);
			return json({ error: 'Could not save the phishing setting' }, { status: 500 });
		}
	}

	if (hasPriority && typeof body?.priorityInbox === 'boolean') {
		if (locals.user.id === DEMO_USER.id) {
			return json({ error: 'Demo mode is read-only' }, { status: 403 });
		}
		if (!db) return json({ error: 'Unauthorized' }, { status: 401 });
		try {
			await setUserPriorityInbox(db, locals.user.id, body.priorityInbox);
			priorityInbox = body.priorityInbox;
			saved = 'account';
		} catch (err) {
			console.error('saving priority inbox failed', err);
			return json({ error: 'Could not save Priority Inbox' }, { status: 500 });
		}
	}

	if (hasSkin && isSkin(body?.skin)) {
		if (db && locals.user.id !== DEMO_USER.id) {
			try {
				await setUserMailSkin(db, locals.user.id, body.skin);
				saved = 'account';
			} catch (err) {
				// The cookie below still remembers the choice on this browser.
				console.error('saving mail skin failed', err);
			}
		}

		cookies.set(SKIN_COOKIE, body.skin, {
			path: '/',
			httpOnly: true,
			secure: true,
			sameSite: 'lax',
			maxAge: YEAR_SECONDS
		});
	}

	return json({
		...(hasSkin && isSkin(body?.skin) ? { skin: body.skin } : {}),
		...(priorityInbox !== undefined ? { priorityInbox } : {}),
		...(undoSendSeconds !== undefined ? { undoSendSeconds } : {}),
		...(vtMaliciousThreshold !== undefined ? { vtMaliciousThreshold } : {}),
		...(phishingToSpam !== undefined ? { phishingToSpam } : {}),
		saved
	});
};
