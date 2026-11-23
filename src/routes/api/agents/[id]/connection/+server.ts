import { json, type RequestHandler } from '@sveltejs/kit';
import { caller, failure, readBody } from '#lib/server/agents-http.ts';
import { ConnectionNotAllowedError, createApiKey, getConnection, revokeConnection } from '#lib/server/external-agents-store.ts';
import { setWebhook, WebhookUrlError } from '#lib/server/agent-webhooks.ts';
import { grantUserId, oauthHelpers } from '#lib/server/mcp/oauth.ts';
import { importMasterKey } from '#lib/server/secret-box.ts';

/**
 * An external agent's connection (external-agents.md, X2, X4), from the Staff page:
 * { action: 'revoke', connectionId } stops it at once (anyone may pull this brake);
 * { action: 'webhook', connectionId, url } sets or clears where events go, and
 * returns the new signing secret once;
 * { action: 'api_key' } makes a new API key (the old one stops) and returns it once.
 */
export const POST: RequestHandler = async ({ params, request, locals, platform, url }) => {
	const who = caller(locals, platform, { write: true });
	if ('response' in who) return who.response;
	const body = await readBody(request);
	if (body?.action === 'api_key') {
		try {
			const { key, connection } = await createApiKey(who.db, { agentId: params.id ?? '', byUserId: who.userId });
			return json({ key, connectionId: connection.id, hint: connection.keyHint });
		} catch (error) {
			if (error instanceof ConnectionNotAllowedError) return json({ error: 'Not allowed' }, { status: 403 });
			return failure(error);
		}
	}
	const connectionId = typeof body?.connectionId === 'string' ? body.connectionId : '';
	const connection = connectionId ? await getConnection(who.db, connectionId) : null;
	if (!connection || connection.agentId !== params.id) return json({ error: 'Not found' }, { status: 404 });
	const env = platform?.env as Env | undefined;

	try {
		if (body?.action === 'revoke') {
			const revoked = await revokeConnection(who.db, { connectionId, byUserId: who.userId });
			// D1 already refuses the connection; this also ends its tokens in the OAuth store.
			if (env?.OAUTH_KV && revoked.auth === 'oauth') {
				try {
					const oauth = await oauthHelpers(env, url.origin);
					const userId = grantUserId(revoked.mailboxUserId);
					const grants = await oauth.listUserGrants(userId);
					for (const grant of grants.items) {
						if (grant.metadata?.connectionId === connectionId) await oauth.revokeGrant(grant.id, userId);
					}
				} catch (error) {
					console.error('Failed to revoke OAuth grant', connectionId, error);
				}
			}
			return json({ status: 'revoked' });
		}
		if (body?.action === 'webhook') {
			if (!env?.AI_KEY_ENCRYPTION_KEY) return json({ error: 'no_key' }, { status: 409 });
			const key = await importMasterKey(env.AI_KEY_ENCRYPTION_KEY);
			const target = typeof body.url === 'string' ? body.url : null;
			return json(await setWebhook(who.db, key, { connectionId, byUserId: who.userId, url: target }));
		}
		return json({ error: 'action' }, { status: 400 });
	} catch (error) {
		if (error instanceof WebhookUrlError) return json({ error: error.code }, { status: 400 });
		if (error instanceof ConnectionNotAllowedError) return json({ error: 'Not allowed' }, { status: 403 });
		return failure(error);
	}
};
