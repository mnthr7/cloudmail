import { json, type RequestHandler } from '@sveltejs/kit';
import { caller, failure, readBody } from '#lib/server/agents-http.ts';
import { createApiKey, hireExternalAgent } from '#lib/server/external-agents-store.ts';
import { setAgentStatus, setAgentTrustedToSend } from '#lib/server/agents-store.ts';

/**
 * Hires an external agent that signs in with an API key (external-agents.md,
 * X9): for Grok's API, scripts and other agents that can't do an OAuth sign-in
 * in a browser. Starts in shadow mode with the external defaults, unless the
 * owner asks for `startActive` (skip shadow mode) and/or `trustedToSend` (send
 * on its own without the 20-approval track record). The key is in the
 * response and never shown again.
 */
export const POST: RequestHandler = async ({ request, locals, platform }) => {
	const who = caller(locals, platform, { write: true });
	if ('response' in who) return who.response;
	const body = await readBody(request);
	const list = (value: unknown) =>
		Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim().toLowerCase()) : [];
	const name = typeof body?.name === 'string' ? body.name.trim() : '';
	const job = typeof body?.job === 'string' && body.job.trim() ? body.job.trim() : 'Help me with email.';
	const readAddresses = list(body?.readAddresses);
	if (!name) return json({ error: 'name' }, { status: 400 });
	if (readAddresses.length === 0) return json({ error: 'read' }, { status: 400 });
	try {
		const agent = await hireExternalAgent(who.db, {
			ownerUserId: who.userId,
			displayName: name,
			job,
			readAddresses,
			sendAs: list(body?.sendAs)
		});
		if (body?.startActive === true) {
			await setAgentStatus(who.db, { agentId: agent.id, byUserId: who.userId, status: 'active' });
		}
		if (body?.trustedToSend === true) {
			await setAgentTrustedToSend(who.db, { agentId: agent.id, byUserId: who.userId, trusted: true });
		}
		const { key, connection } = await createApiKey(who.db, { agentId: agent.id, byUserId: who.userId });
		return json({ agentId: agent.id, connectionId: connection.id, key }, { status: 201 });
	} catch (error) {
		if (error instanceof Error && error.message === 'Enter a name for the agent') return json({ error: 'name' }, { status: 400 });
		return failure(error);
	}
};
