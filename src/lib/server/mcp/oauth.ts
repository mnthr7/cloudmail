import type { OAuthHelpers, OAuthProviderOptions } from '@cloudflare/workers-oauth-provider';

/**
 * OAuth 2.1 for external agents (docs/specs/external-agents.md, X2): PKCE,
 * dynamic client registration and token rotation come from
 * workers-oauth-provider, which keeps its grants and tokens in OAUTH_KV.
 * CloudMail adds the consent screen (/oauth/authorize) and checks the
 * connection a grant points at on every MCP request.
 */

export const MCP_PATH = '/mcp';
export const AUTHORIZE_PATH = '/oauth/authorize';
export const TOKEN_PATH = '/oauth/token';
export const REGISTER_PATH = '/oauth/register';

/** One scope: acting as the agent the founder set up. What it may do is the agent's capabilities, not scopes. */
export const MCP_SCOPE = 'agent';

/** Access tokens last an hour (X2). */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
/** A refresh token is replaced every time it's used; an unused grant ends after 30 days. */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * The provider's options, shared by the Worker and the consent page. The
 * resource (what tokens are for) is this site's /mcp, so it depends on the
 * origin the deploy is served from; a template doesn't know that in advance.
 */
export function oauthSettings(origin: string) {
	return {
		authorizeEndpoint: AUTHORIZE_PATH,
		tokenEndpoint: TOKEN_PATH,
		clientRegistrationEndpoint: REGISTER_PATH,
		scopesSupported: [MCP_SCOPE],
		accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
		refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
		resourceMetadata: { resource: `${origin}${MCP_PATH}`, resource_name: 'CloudMail' }
	} satisfies Partial<OAuthProviderOptions<Env>>;
}

const NOT_HERE = { fetch: () => new Response('Not found', { status: 404 }) };

/**
 * The provider's helpers for SvelteKit routes. The provider hands them to the
 * default handler as `env.OAUTH_PROVIDER`, but SvelteKit reads bindings from
 * `cloudflare:workers` (hooks.server.ts), which doesn't carry them, so they're
 * built here from the same settings.
 */
export async function oauthHelpers(env: Env, origin: string): Promise<OAuthHelpers> {
	if (!env.OAUTH_KV) throw new Error('OAUTH_KV is not bound');
	// Loaded on use: the library imports `cloudflare:workers`, which SvelteKit's
	// build can't load while it analyses routes in Node.
	const { getOAuthApi } = await import('@cloudflare/workers-oauth-provider');
	return getOAuthApi<Env>(
		{ ...oauthSettings(origin), apiRoute: MCP_PATH, apiHandler: NOT_HERE as never, defaultHandler: NOT_HERE as never },
		env
	);
}

/** The grant's user id for the provider: may not contain ':' (it separates parts of tokens). */
export function grantUserId(userId: string): string {
	return encodeURIComponent(userId);
}
