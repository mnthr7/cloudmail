import { json, type RequestHandler } from '@sveltejs/kit';
import { caller, failure, readBody } from '#lib/server/agents-http.ts';
import { ProviderKeyError, removeProviderKey, setProviderKey } from '#lib/server/ai-provider-store.ts';
import { checkProviderKey } from '#lib/server/ai-providers.ts';
import { importMasterKey, SecretBoxError } from '#lib/server/secret-box.ts';

/**
 * PUT  { provider, apiKey } saves the workspace's key for a provider, after the provider accepts it.
 * DELETE { provider } removes it. Admins only. The key is never sent back.
 */

const MESSAGES: Record<ProviderKeyError['code'], [number, string]> = {
	provider: [400, 'Choose a provider.'],
	key: [400, "That doesn't look like an API key."],
	rejected: [400, 'The provider turned this key down. Check it and try again.'],
	unreachable: [502, "Couldn't reach the provider to check the key. Try again in a minute."],
	encryption: [503, 'AI_KEY_ENCRYPTION_KEY is not set on this server, so keys cannot be stored safely.']
};

function keyFailure(error: unknown): Response {
	if (error instanceof ProviderKeyError) {
		const [status, message] = MESSAGES[error.code];
		return json({ error: error.code, message }, { status });
	}
	return failure(error);
}

export const PUT: RequestHandler = async ({ request, locals, platform }) => {
	const who = caller(locals, platform, { write: true });
	if ('response' in who) return who.response;
	if (!locals.user?.is_admin) return json({ error: 'Forbidden' }, { status: 403 });
	const body = await readBody(request);
	if (!body) return json({ error: 'Invalid body' }, { status: 400 });

	let masterKey: CryptoKey | null = null;
	try {
		masterKey = await importMasterKey(platform?.env.AI_KEY_ENCRYPTION_KEY);
	} catch (error) {
		if (!(error instanceof SecretBoxError)) throw error;
	}

	try {
		const status = await setProviderKey(who.db, {
			userId: who.userId,
			provider: body.provider,
			apiKey: body.apiKey,
			masterKey,
			check: checkProviderKey
		});
		return json({ provider: status });
	} catch (error) {
		return keyFailure(error);
	}
};

export const DELETE: RequestHandler = async ({ request, locals, platform }) => {
	const who = caller(locals, platform, { write: true });
	if ('response' in who) return who.response;
	if (!locals.user?.is_admin) return json({ error: 'Forbidden' }, { status: 403 });
	const body = await readBody(request);
	if (!body) return json({ error: 'Invalid body' }, { status: 400 });
	try {
		const removed = await removeProviderKey(who.db, { userId: who.userId, provider: body.provider });
		return removed ? json({ removed: true }) : json({ error: 'Not found' }, { status: 404 });
	} catch (error) {
		return keyFailure(error);
	}
};
