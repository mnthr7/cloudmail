import type { RequestHandler } from './$types';
import { AgentDefinitionError } from '#lib/agents/definition.ts';
import {
	createExternalAgent,
	reconnectableAgents,
	reconnectExternalAgent,
	setGrantRef
} from '#lib/server/external-agents-store.ts';
import {
	consentCsp,
	consentFormError,
	parseConsentForm,
	renderConsentError,
	renderConsentPage
} from '#lib/server/mcp/consent-page.ts';
import { grantUserId, MCP_SCOPE, oauthHelpers } from '#lib/server/mcp/oauth.ts';

/**
 * The consent screen MCP clients send the founder to (external-agents.md, X2).
 * hooks.server.ts has already signed them in (or sent them to /login and back).
 */

function html(body: string, status = 200, headers = new Headers()): Response {
	headers.set('Content-Type', 'text/html; charset=utf-8');
	headers.set('Cache-Control', 'no-store');
	if (!headers.has('Content-Security-Policy')) headers.set('Content-Security-Policy', consentCsp(''));
	headers.set('X-Frame-Options', 'DENY');
	return new Response(body, { status, headers });
}

async function handleError(error: unknown): Promise<Response> {
	const { AuthorizationError, CimdFetchError } = await import('@cloudflare/workers-oauth-provider');
	if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
	if (error instanceof AuthorizationError) return html(renderConsentError(error.description ?? 'This request is no longer valid.'), 400);
	if (error instanceof CimdFetchError) return html(renderConsentError('This app could not be verified.'), 400);
	throw error;
}

function unavailable(env: Env | undefined): Response | null {
	if (!env?.OAUTH_KV || env.DEMO_MODE === 'true') {
		return html(renderConsentError('Connecting agents isn’t set up on this CloudMail.'), 404);
	}
	return null;
}

export const GET: RequestHandler = async ({ request, locals, platform }) => {
	const env = platform?.env as Env | undefined;
	const off = unavailable(env);
	if (off) return off;
	const user = locals.user;
	if (!user) return html(renderConsentError('Sign in first.'), 401);
	try {
		const oauth = await oauthHelpers(env!, new URL(request.url).origin);
		const authRequest = await oauth.parseAuthRequest(request);
		// Described first: a failed lookup leaves nothing behind in KV.
		const details = await oauth.describeConsent(authRequest);
		const consent = await oauth.beginConsent(authRequest);
		consent.headers.set('Content-Security-Policy', consentCsp(details.redirectUri));
		return html(
			renderConsentPage({
				details,
				handle: consent.handle,
				founderName: user.name,
				addresses: locals.addresses.map((address) => address.address),
				reconnectable: await reconnectableAgents(env!.DB, user.id)
			}),
			200,
			consent.headers
		);
	} catch (error) {
		return await handleError(error);
	}
};

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	const env = platform?.env as Env | undefined;
	const off = unavailable(env);
	if (off) return off;
	const user = locals.user;
	if (!user) return html(renderConsentError('Sign in first.'), 401);
	const db = env!.DB;
	try {
		const oauth = await oauthHelpers(env!, new URL(request.url).origin);
		const data = await request.formData();
		const handle = String(data.get('handle') ?? '');
		if (data.get('decision') !== 'approve') {
			const denied = await oauth.denyConsent(request, handle);
			return new Response(null, { status: 302, headers: denied.headers });
		}

		const form = parseConsentForm(data);
		const problem = consentFormError(form, locals.addresses.map((address) => address.address));
		// Checked before the handle is used up, so going back and fixing it still works.
		if (problem) return html(renderConsentError(`${problem} Go back and try again.`), 400);

		const approved = await oauth.approveConsent(request, handle, { scope: [MCP_SCOPE] });
		const client = await oauth.lookupClient(approved.request.clientId);
		const clientName = client?.clientName ?? approved.request.clientId;

		let connection;
		try {
			connection = form.reconnectAgentId
				? (await reconnectExternalAgent(db, { agentId: form.reconnectAgentId, byUserId: user.id, clientName, clientId: approved.request.clientId }))
						.connection
				: (
						await createExternalAgent(db, {
							ownerUserId: user.id,
							displayName: form.displayName,
							job: form.job || `Help ${user.name} with email.`,
							readAddresses: form.readAddresses,
							sendAs: form.sendAs,
							levels: form.levels,
							clientName,
							clientId: approved.request.clientId
						})
					).connection;
		} catch (error) {
			if (error instanceof AgentDefinitionError) {
				return html(renderConsentError('Those settings aren’t allowed for an external agent.'), 400);
			}
			if (error instanceof Error && error.name === 'ConnectionNotAllowedError') {
				return html(renderConsentError('You can’t reconnect that agent.'), 403);
			}
			throw error;
		}

		const { redirectTo } = await oauth.completeAuthorization({
			request: approved.request,
			userId: grantUserId(user.id),
			metadata: { connectionId: connection.id, agentId: connection.agentId },
			scope: [MCP_SCOPE],
			// The only thing the token carries. Everything else is read from D1 on each request.
			props: { connectionId: connection.id },
			// Each connection is its own agent; reconnecting revokes the old one in D1 instead.
			revokeExistingGrants: false
		});
		await setGrantRef(db, connection.id, approved.request.clientId);
		approved.headers.set('Location', redirectTo);
		return new Response(null, { status: 302, headers: approved.headers });
	} catch (error) {
		return await handleError(error);
	}
};
