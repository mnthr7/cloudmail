import { json, type RequestHandler } from '@sveltejs/kit';
import type { AgentStatus } from '#lib/agents/policy.ts';
import { caller, failure, readBody } from '#lib/server/agents-http.ts';
import {
	getAgentForUser,
	setAgentAiFooter,
	setAgentStatus,
	setAgentTrustedToSend,
	updateAgentDefinition
} from '#lib/server/agents-store.ts';

const STATUSES: readonly AgentStatus[] = ['shadow', 'active', 'paused'];

export const GET: RequestHandler = async ({ params, locals, platform }) => {
	const who = caller(locals, platform, { write: false });
	if ('response' in who) return who.response;
	try {
		return json({ agent: await getAgentForUser(who.db, params.id ?? '', who.userId) });
	} catch (error) {
		return failure(error);
	}
};

/**
 * Change an agent. `{ status }` pauses, resumes, or ends shadow mode early.
 * `{ definition }` saves a new version (A3). `{ trustedToSend }` lets an
 * external agent send on its own without the 20-approval track record.
 * `{ aiFooter }` turns the "is an AI assistant" line on its mail on or off.
 * One of these per request.
 */
export const PATCH: RequestHandler = async ({ params, request, locals, platform }) => {
	const who = caller(locals, platform, { write: true });
	if ('response' in who) return who.response;

	const id = params.id ?? '';
	const body = await readBody(request);
	if (!body) return json({ error: 'Bad request' }, { status: 400 });
	const hasStatus = 'status' in body;
	const hasDefinition = 'definition' in body;
	const hasTrust = 'trustedToSend' in body;
	const hasFooter = 'aiFooter' in body;
	if ([hasStatus, hasDefinition, hasTrust, hasFooter].filter(Boolean).length !== 1) {
		return json({ error: 'Bad request' }, { status: 400 });
	}

	try {
		if (hasFooter) {
			if (typeof body.aiFooter !== 'boolean') return json({ error: 'aiFooter' }, { status: 400 });
			await setAgentAiFooter(who.db, { agentId: id, byUserId: who.userId, on: body.aiFooter });
		} else if (hasTrust) {
			if (typeof body.trustedToSend !== 'boolean') return json({ error: 'trustedToSend' }, { status: 400 });
			await setAgentTrustedToSend(who.db, { agentId: id, byUserId: who.userId, trusted: body.trustedToSend });
		} else if (hasStatus) {
			const status = body.status as AgentStatus;
			if (!STATUSES.includes(status)) return json({ error: 'status' }, { status: 400 });
			await setAgentStatus(who.db, { agentId: id, byUserId: who.userId, status });
		} else {
			await updateAgentDefinition(who.db, { agentId: id, byUserId: who.userId, definition: body.definition });
		}
		return json({ agent: await getAgentForUser(who.db, id, who.userId) });
	} catch (error) {
		return failure(error);
	}
};
