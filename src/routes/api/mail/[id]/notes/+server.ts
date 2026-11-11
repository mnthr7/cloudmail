import { json, type RequestHandler } from '@sveltejs/kit';
import { findMentions } from '#lib/agents/mentions.ts';
import { addMemory, MemoryError } from '#lib/server/agent-memory-store.ts';
import { askableAgents, enqueueAskRun, AskError, MAX_REQUEST_LENGTH, threadAgent } from '#lib/server/agent-runs-store.ts';
import { humanPrincipalForUser, NotAllowedError } from '#lib/server/agents-store.ts';
import { getEmailForUser } from '#lib/server/mail-store.ts';
import { addThreadNote, threadActivity } from '#lib/server/thread-activity-store.ts';
import { DEMO_MODE, DEMO_USER } from '#lib/server/demo.ts';
import { startAgentsNow } from '#lib/server/start-agents.ts';

/**
 * A private note on a thread, only for the mailbox owner. Mentioning an agent
 * hands it the thread with the note as its request; "@Agent remember: …"
 * adds the fact to its memory. Both need the right to change that agent.
 * A note that names no agent goes to the agent already working the thread,
 * unless it's marked as just for you ({ private: true }). The agent starts at once.
 */
export const POST: RequestHandler = async ({ params, request, locals, platform }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (DEMO_MODE && locals.user.id === DEMO_USER.id) return json({ error: 'Demo mode is read-only' }, { status: 403 });
	const db = platform?.env.DB;
	if (!db) return json({ error: 'Unauthorized' }, { status: 401 });

	const body = (await request.json().catch(() => null)) as { body?: unknown; private?: unknown } | null;
	const justForMe = body?.private === true;
	const note = typeof body?.body === 'string' ? body.body.trim() : '';
	if (!note || note.length > MAX_REQUEST_LENGTH) return json({ error: 'note' }, { status: 400 });

	const email = await getEmailForUser(db, locals.user.id, params.id ?? '');
	if (!email) return json({ error: 'Not found' }, { status: 404 });
	const threadId = email.thread_id ?? email.id;
	const human = await humanPrincipalForUser(db, locals.user.id);

	await addThreadNote(db, {
		workspaceId: human.workspace_id,
		mailboxUserId: locals.user.id,
		threadId,
		authorId: human.id,
		kind: 'note',
		body: note
	});

	const agents = await askableAgents(db, locals.user.id).catch(() => []);
	const results: Array<{ agent: string; outcome: 'asked' | 'remembered' | 'refused'; error?: string }> = [];
	let mentions = findMentions(note, agents.map((agent) => ({ id: agent.id, name: agent.name })));
	if (mentions.length === 0 && !justForMe) {
		const working = await threadAgent(db, locals.user.id, threadId, agents.map((agent) => agent.id));
		if (working) mentions = [{ agentId: working, kind: 'request' }];
	}
	for (const mention of mentions) {
		const name = agents.find((agent) => agent.id === mention.agentId)?.name ?? '';
		try {
			if (mention.kind === 'remember') {
				await addMemory(db, { agentId: mention.agentId, fact: mention.fact, source: 'founder', byUserId: locals.user.id });
				results.push({ agent: name, outcome: 'remembered' });
			} else {
				await enqueueAskRun(db, { agentId: mention.agentId, byUserId: locals.user.id, emailId: email.id, request: note });
				results.push({ agent: name, outcome: 'asked' });
			}
		} catch (error) {
			if (error instanceof AskError || error instanceof MemoryError || error instanceof NotAllowedError) {
				results.push({ agent: name, outcome: 'refused', error: error instanceof NotAllowedError ? 'not_allowed' : error.code });
				continue;
			}
			throw error;
		}
	}

	if (results.some((result) => result.outcome === 'asked')) startAgentsNow(platform, human.workspace_id);

	return json({ mentions: results, activity: await threadActivity(db, locals.user.id, threadId) });
};
