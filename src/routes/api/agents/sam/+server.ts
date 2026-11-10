import { json, type RequestHandler } from '@sveltejs/kit';
import { caller, failure, readBody } from '#lib/server/agents-http.ts';
import { createAgent } from '#lib/server/agents-store.ts';
import { samDefinition, SAM_NAME } from '#lib/agents/sam.ts';
import { parseEmailAddress } from '#lib/email-address.ts';

/**
 * Hire Sam, the generalist, at an address the user can send from (usually a
 * new sam@ address). Like any new agent he starts in shadow mode.
 */
export const POST: RequestHandler = async ({ request, locals, platform }) => {
	const who = caller(locals, platform, { write: true });
	if ('response' in who) return who.response;
	const body = await readBody(request);
	const address = typeof body?.address === 'string' ? parseEmailAddress(body.address) : '';
	if (!address) return json({ error: 'address' }, { status: 400 });
	try {
		const agent = await createAgent(who.db, {
			ownerUserId: who.userId,
			displayName: SAM_NAME,
			definition: samDefinition(address)
		});
		return json({ id: agent.id }, { status: 201 });
	} catch (error) {
		return failure(error);
	}
};
