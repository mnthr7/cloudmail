import { json, type RequestHandler } from '@sveltejs/kit';
import {
	readUndoSendSeconds,
	readVtThreshold,
	setUserMailSkin,
	setUserPriorityInbox,
	setUserUndoSendSeconds,
	setUserVtThreshold
} from '$lib/server/auth';
import { DEMO_USER } from '$lib/server/demo';
import { parseThreshold } from '$lib/security/verdict';
import { SKIN_COOKIE, isSkin } from '$lib/skin';
import { parseUndoSeconds, type UndoSeconds } from '$lib/writing/timing';

const YEAR_SECONDS = 365 * 24 * 60 * 60;

/** Per-account UI preferences: mail skin, Priority Inbox, Undo Send, and the scan threshold. */
export const PATCH: RequestHandler = async ({ request, locals, platform, cookies }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const body = (await request.json().catch(() => null)) as {
		skin?: unknown;
		priorityInbox?: unknown;
		undoSendSeconds?: unknown;
		vtMaliciousThreshold?: unknown;
	} | null;

	const hasSkin = Boolean(body && Object.prototype.hasOwnProperty.call(body, 'skin'));
	const hasPriority = Boolean(body && Object.prototype.hasOwnProperty.call(body, 'priorityInbox'));
	const hasUndo = Boolean(body && Object.prototype.hasOwnProperty.call(body, 'undoSendSeconds'));
	const hasThreshold = Boolean(
		body && Object.prototype.hasOwnProperty.call(body, 'vtMaliciousThreshold')
	);

	if (!hasSkin && !hasPriority && !hasUndo && !hasThreshold) {
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
		saved
	});
};
