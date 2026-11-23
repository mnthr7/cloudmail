import type { ExecutionContext } from '@cloudflare/workers-types';
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import {
	handleCloudflareInbound,
	type CloudflareInboundEnv,
	type CloudflareInboundMessage
} from './lib/server/cloudflare-inbound';
import { readVtThreshold } from './lib/server/auth';
import { scanPending } from './lib/server/attachment-scan';
import { getEmailProvider } from './lib/server/context';
import type { EmailProvider } from './lib/server/email-provider';
import { expireActions } from './lib/server/agents-store';
import { executePending, fireDueTimers } from './lib/server/agent-executor';
import { connectionForApiKey, isApiKey, pruneAudit } from './lib/server/external-agents-store';
import { deliverWebhooks } from './lib/server/agent-webhooks';
import { handleMcpRequest } from './lib/server/mcp/server';
import { MCP_PATH, oauthSettings, REGISTER_PATH, TOKEN_PATH } from './lib/server/mcp/oauth';
import { runAgentsNow, sendBriefsNow } from './lib/server/run-agents';
import { importMasterKey } from './lib/server/secret-box';
import { deliverDue } from './lib/server/outbox-schedule';
import { syncDueOutsideCalendars } from './lib/server/outside-calendars';
import { sendDueReminders } from './lib/server/booking-manage';
import { createVirusTotal } from './lib/server/virus-total';
// Renamed from `_worker.js` by `scripts/wrap-cloudflare-worker.mjs` after `vite build`.
// @ts-expect-error file is created at build time
import sveltekit from '../.svelte-kit/cloudflare/_sveltekit.js';

type SvelteKitWorker = {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response;
};

const svelteApp = sveltekit as SvelteKitWorker;

/**
 * Optional redirect from a path on another host to the mail host, e.g.
 * PATH_REDIRECT_FROM="example.com/mail" and PATH_REDIRECT_TO="mail.example.com"
 * send example.com/mail/inbox to mail.example.com/inbox. Off unless both are set.
 */
function pathRedirect(request: Request, env: Env): Response | null {
	const from = env.PATH_REDIRECT_FROM?.trim();
	const to = env.PATH_REDIRECT_TO?.trim();
	if (!from || !to) return null;

	const slash = from.indexOf('/');
	const host = slash === -1 ? from : from.slice(0, slash);
	const prefix = slash === -1 ? '' : from.slice(slash).replace(/\/+$/, '');
	const url = new URL(request.url);
	if (url.hostname !== host) return null;
	if (prefix && url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return null;

	url.pathname = url.pathname.slice(prefix.length) || '/';
	url.hostname = to;
	return Response.redirect(url.toString(), 302);
}

function serveApp(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
	const redirect = pathRedirect(request, env);
	if (redirect) return redirect;
	if (typeof svelteApp.fetch !== 'function') {
		throw new Error('SvelteKit worker export is missing fetch');
	}
	return svelteApp.fetch(request, env, ctx);
}

/**
 * External agents (docs/specs/external-agents.md): /mcp needs an OAuth access
 * token. The provider answers /oauth/token, /oauth/register and the
 * .well-known metadata; everything else, the consent page included, is SvelteKit.
 */
const oauthProviders = new Map<string, OAuthProvider<Env>>();

function oauthProviderFor(origin: string): OAuthProvider<Env> {
	let provider = oauthProviders.get(origin);
	if (!provider) {
		provider = new OAuthProvider<Env>({
			...oauthSettings(origin),
			apiRoute: MCP_PATH,
			apiHandler: {
				fetch: (request: Request, env: Env, ctx: ExecutionContext & { props?: unknown }) =>
					handleMcpRequest(request, ctx.props, { db: env.DB, provider: providerOrNull(env), bucket: env.ATTACHMENTS })
			} as never,
			defaultHandler: { fetch: serveApp } as never
		});
		oauthProviders.set(origin, provider);
	}
	return provider;
}

/**
 * /mcp with an API key (`Authorization: Bearer cmk_…`), for agents that can't
 * sign in through a browser. Null when the request isn't one, so OAuth handles it.
 */
async function apiKeyMcp(request: Request, env: Env): Promise<Response | null> {
	if (new URL(request.url).pathname !== MCP_PATH) return null;
	const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
	if (!token || !isApiKey(token)) return null;
	const connection = await connectionForApiKey(env.DB, token);
	if (!connection) {
		return Response.json(
			{ jsonrpc: '2.0', error: { code: -32001, message: 'invalid_api_key' }, id: null },
			{ status: 401, headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' } }
		);
	}
	return handleMcpRequest(request, { connectionId: connection.id }, { db: env.DB, provider: providerOrNull(env), bucket: env.ATTACHMENTS });
}

/** Paths only the OAuth provider serves. Without it (no OAUTH_KV, or demo mode) they don't exist. */
function isAgentAuthPath(pathname: string): boolean {
	return (
		pathname === MCP_PATH ||
		pathname.startsWith(`${MCP_PATH}/`) ||
		pathname === TOKEN_PATH ||
		pathname === REGISTER_PATH ||
		pathname.startsWith('/.well-known/oauth-')
	);
}

/**
 * SvelteKit's generated Worker is fetch-only. This wrapper keeps HTTP on
 * SvelteKit and adds Cloudflare Email Service's `email()` handler.
 */
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		if (env.DEMO_MODE !== 'true') {
			const keyed = await apiKeyMcp(request, env);
			if (keyed) return keyed;
		}
		if (env.OAUTH_KV && env.DEMO_MODE !== 'true') {
			return oauthProviderFor(new URL(request.url).origin).fetch(request as never, env, ctx as never) as Promise<Response>;
		}
		if (isAgentAuthPath(new URL(request.url).pathname)) return new Response('Not found', { status: 404 });
		return serveApp(request, env, ctx);
	},

	async email(message: CloudflareInboundMessage, env: Env, ctx: ExecutionContext) {
		if (env.EMAIL_PROVIDER?.trim().toLowerCase() !== 'cloudflare') {
			message.setReject('Cloudflare email provider is not enabled');
			return;
		}

		let provider: EmailProvider | undefined;
		try {
			provider = getEmailProvider({ env });
		} catch (error) {
			// Filing still proceeds. A missing provider only blocks filter forwards.
			console.error('Failed to load email provider for inbound forward', error);
		}

		const inboundEnv: CloudflareInboundEnv = {
			DB: env.DB,
			ATTACHMENTS: env.ATTACHMENTS,
			provider
		};

		await handleCloudflareInbound(message, inboundEnv);
		// New mail may have woken an agent: start it now rather than on the next minute's cron.
		if (env.DEMO_MODE !== 'true') {
			ctx.waitUntil(runAgents(env).catch((error) => console.error('Failed to run agents', error)));
		}
	},

	async scheduled(_event: unknown, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(
			deliverDue(env.DB, getEmailProvider({ env }), new Date(), 20)
				// Booking reminders go out from the host's own address, after scheduled mail.
				.then(() => (env.DEMO_MODE === 'true' ? 0 : sendDueReminders(env.DB, getEmailProvider({ env }), new Date())))
				// Prep briefs to the host on the meeting day, written by the agent running the page.
				.then(() => (env.DEMO_MODE === 'true' ? 0 : sendBriefsNow(env, getEmailProvider({ env }))))
				.then(
					() => undefined,
					(error) => console.error('Failed to deliver scheduled mail', error)
				)
		);
		// Proposals nobody approved in time are never sent late (A7). Allowed
		// actions whose request was cut off are finished, once.
		ctx.waitUntil(
			expireActions(env.DB)
				.then(() => (env.DEMO_MODE === 'true' ? 0 : executePending(env.DB, new Date(), 10, { provider: providerOrNull(env) })))
				// External agents' follow-up timers, then their 90-day audit window.
				.then(() => (env.DEMO_MODE === 'true' ? 0 : fireDueTimers(env.DB, new Date())))
				.then(() => (env.DEMO_MODE === 'true' ? 0 : deliverAgentWebhooks(env).then(() => 0)))
				.then(() => (new Date().getUTCMinutes() === 7 ? pruneAudit(env.DB, new Date()) : 0))
				.then(
					() => undefined,
					(error) => console.error('Failed to expire or finish agent actions', error)
				)
		);
		ctx.waitUntil(
			runAgents(env).then(
				() => undefined,
				(error) => console.error('Failed to run agents', error)
			)
		);
		// Outside calendars (Google, iCloud, Outlook links): a few due ones each minute.
		if (env.AI_KEY_ENCRYPTION_KEY && env.DEMO_MODE !== 'true') {
			ctx.waitUntil(
				importMasterKey(env.AI_KEY_ENCRYPTION_KEY)
					.then((key) => syncDueOutsideCalendars(env.DB, key, (url, init) => fetch(url, init)))
					.then(
						() => undefined,
						(error) => console.error('Failed to refresh outside calendars', error)
					)
			);
		}
		ctx.waitUntil(
			scanDueAttachments(env).then(
				() => undefined,
				(error) => console.error('Failed to scan attachments', error)
			)
		);
	}
};

async function runAgents(env: Env): Promise<void> {
	if (env.DEMO_MODE === 'true') return;
	await runAgentsNow(env, providerOrNull(env));
}

/** Webhooks to external agents. Their signing secrets are sealed with the same key as AI keys. */
async function deliverAgentWebhooks(env: Env): Promise<void> {
	const key = env.AI_KEY_ENCRYPTION_KEY ? await importMasterKey(env.AI_KEY_ENCRYPTION_KEY) : null;
	await deliverWebhooks(env.DB, key, (url, init) => fetch(url, init));
}

async function scanDueAttachments(env: Env): Promise<void> {
	if (!env.VIRUSTOTAL_API_KEY || env.DEMO_MODE === 'true') return;
	await scanPending(env.DB, env.ATTACHMENTS, createVirusTotal(env.VIRUSTOTAL_API_KEY), readVtThreshold);
}

/** The mail provider, or null when sending isn't set up (calendar changes still happen; updates aren't sent). */
function providerOrNull(env: Env): EmailProvider | null {
	try {
		return getEmailProvider({ env });
	} catch {
		return null;
	}
}
