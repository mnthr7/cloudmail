import { json, type RequestHandler } from '@sveltejs/kit';
import { getEmailForUser } from '#lib/server/mail-store.ts';
import { handBackThread, takeOverThread, threadActivity } from '#lib/server/thread-activity-store.ts';

/**
 * Take a thread over so agents stop acting on it (POST), or hand it back
 * (DELETE). Only the mailbox owner can, since it is their copy of the thread.
 */
async function threadFor(platform: App.Platform | undefined, userId: string | undefined, emailId: string) {
	const db = platform?.env.DB;
	if (!db || !userId) return null;
	const email = await getEmailForUser(db, userId, emailId);
	return email ? { db, userId, threadId: email.thread_id ?? email.id } : null;
}

export const POST: RequestHandler = async ({ params, locals, platform }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	const found = await threadFor(platform, locals.user.id, params.id ?? '');
	if (!found) return json({ error: 'Not found' }, { status: 404 });
	await takeOverThread(found.db, found.userId, found.threadId);
	return json({ activity: await threadActivity(found.db, found.userId, found.threadId) });
};

export const DELETE: RequestHandler = async ({ params, locals, platform }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	const found = await threadFor(platform, locals.user.id, params.id ?? '');
	if (!found) return json({ error: 'Not found' }, { status: 404 });
	await handBackThread(found.db, found.userId, found.threadId);
	return json({ activity: await threadActivity(found.db, found.userId, found.threadId) });
};
