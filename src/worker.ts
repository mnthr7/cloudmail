import type { ExecutionContext } from '@cloudflare/workers-types';
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
import { runDueAgents } from './lib/server/agent-runner';
import { executePending } from './lib/server/agent-executor';
import { loadProviderKey, markProviderKeyRejected, workspacesWithWorkingKey } from './lib/server/ai-provider-store';
import { clientFor } from './lib/server/ai-providers';
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

/**
 * SvelteKit's generated Worker is fetch-only. This wrapper keeps HTTP on
 * SvelteKit and adds Cloudflare Email Service's `email()` handler.
 */
export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const redirect = pathRedirect(request, env);
		if (redirect) return redirect;
		if (typeof svelteApp.fetch !== 'function') {
			throw new Error('SvelteKit worker export is missing fetch');
		}
		return svelteApp.fetch(request, env, ctx);
	},

	async email(message: CloudflareInboundMessage, env: Env) {
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
	},

	async scheduled(_event: unknown, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(
			deliverDue(env.DB, getEmailProvider({ env }), new Date(), 20)
				// Booking reminders go out from the host's own address, after scheduled mail.
				.then(() => (env.DEMO_MODE === 'true' ? 0 : sendDueReminders(env.DB, getEmailProvider({ env }), new Date())))
				.then(
					() => undefined,
					(error) => console.error('Failed to deliver scheduled mail', error)
				)
		);
		// Proposals nobody approved in time are never sent late (A7). Allowed
		// actions whose request was cut off are finished, once.
		ctx.waitUntil(
			expireActions(env.DB)
				.then(() => (env.DEMO_MODE === 'true' ? 0 : executePending(env.DB)))
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

/**
 * Agents run on their workspace's own provider key, which an admin sets on the
 * Admin page. Workspaces without one keep their runs waiting.
 */
async function runAgents(env: Env): Promise<void> {
	if (!env.AI_KEY_ENCRYPTION_KEY || env.DEMO_MODE === 'true') return;
	const masterKey = await importMasterKey(env.AI_KEY_ENCRYPTION_KEY);
	const workspaces = await workspacesWithWorkingKey(env.DB, 'anthropic');
	if (workspaces.length === 0) return;
	await runDueAgents(env.DB, {
		workspaces,
		async clientFor(workspaceId) {
			try {
				const apiKey = await loadProviderKey(env.DB, masterKey, workspaceId, 'anthropic');
				return apiKey ? clientFor('anthropic', apiKey) : null;
			} catch (error) {
				// Most likely AI_KEY_ENCRYPTION_KEY changed since the key was saved.
				console.error('Could not open the workspace AI key', workspaceId, error);
				return null;
			}
		},
		keyRejected: (workspaceId) => markProviderKeyRejected(env.DB, workspaceId, 'anthropic')
	});
}

async function scanDueAttachments(env: Env): Promise<void> {
	if (!env.VIRUSTOTAL_API_KEY || env.DEMO_MODE === 'true') return;
	await scanPending(env.DB, env.ATTACHMENTS, createVirusTotal(env.VIRUSTOTAL_API_KEY), readVtThreshold);
}
