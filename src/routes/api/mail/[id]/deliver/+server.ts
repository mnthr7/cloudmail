import { json, type RequestHandler } from '@sveltejs/kit';
import {
	describeProviderError,
	getEmailProvider,
	statusForProviderError
} from '$lib/server/context';
import { claimScheduled, loadScheduledOutbound } from '$lib/server/outbox-schedule';
import { sendOutboundEmail } from '$lib/server/send-mail';

/** Sends one due scheduled row. The cron uses the same claim. */
export const POST: RequestHandler = async ({ params, locals, platform }) => {
	const db = platform?.env.DB;
	if (!locals.user || !db) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	let provider;
	try {
		provider = getEmailProvider(platform);
	} catch (error) {
		return json({ error: describeProviderError(error) }, { status: statusForProviderError(error) });
	}

	const id = params.id!;
	const claimed = await claimScheduled(db, id, locals.user.id, new Date(), provider);
	if (!claimed) {
		const row = await db
			.prepare('SELECT status FROM emails WHERE id = ? AND user_id = ?')
			.bind(id, locals.user.id)
			.first<{ status: string | null }>();
		if (!row) {
			return json({ error: 'Not found' }, { status: 404 });
		}
		if (row.status === 'scheduled') {
			return json({ error: 'Not due' }, { status: 409 });
		}
		return json({ error: 'Already sent' }, { status: 409 });
	}

	try {
		const result = await sendOutboundEmail(
			provider,
			await loadScheduledOutbound(db, { id, user_id: locals.user.id })
		);
		await db
			.prepare('UPDATE emails SET provider_id = ? WHERE id = ? AND user_id = ?')
			.bind(result.providerId, id, locals.user.id)
			.run();
		return json({ ok: true });
	} catch (error) {
		const message = error instanceof Error && error.message ? error.message : 'Send failed';
		await db
			.prepare(
				`UPDATE emails SET status = 'failed', status_detail = ?
				 WHERE id = ? AND user_id = ?`
			)
			.bind(message, id, locals.user.id)
			.run();
		return json({ error: describeProviderError(error) }, { status: statusForProviderError(error) });
	}
};
