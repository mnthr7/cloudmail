import { json, type RequestHandler } from '@sveltejs/kit';
import { getEmailProvider } from '#lib/server/context.ts';
import { DEMO_MODE, DEMO_USER } from '#lib/server/demo.ts';
import type { EmailProvider } from '#lib/server/email-provider.ts';
import { ConfigError } from '#lib/server/errors.ts';
import {
	UnsubscribeError,
	UnsubscribeNotFoundError,
	unsubscribeMessage
} from '#lib/server/unsubscribe.ts';

/** One unsubscribe for this message. The message row is left as it is. */
export const POST: RequestHandler = async ({ params, locals, platform }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	// Demo mode is server-env only (DEMO_MODE="true"), never a URL param.
	if (DEMO_MODE && locals.user.id === DEMO_USER.id) {
		return json({ error: 'Demo mode is read-only' }, { status: 403 });
	}

	const db = platform?.env.DB;
	if (!db) return json({ error: 'Unauthorized' }, { status: 401 });

	const id = params.id;
	if (!id) return json({ error: 'Not found' }, { status: 404 });

	try {
		await unsubscribeMessage(db, locals.user, id, {
			resolveProvider: () => loadProvider(platform)
		});
		return json({ ok: true });
	} catch (error) {
		if (error instanceof UnsubscribeNotFoundError) {
			return json({ error: 'Not found' }, { status: 404 });
		}
		if (error instanceof UnsubscribeError) {
			return json({ error: error.code }, { status: 400 });
		}
		throw error;
	}
};

function loadProvider(platform: App.Platform | undefined): EmailProvider | undefined {
	try {
		return getEmailProvider(platform);
	} catch (error) {
		if (error instanceof ConfigError) return undefined;
		throw error;
	}
}
