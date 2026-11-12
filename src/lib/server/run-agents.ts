import type { D1Database } from '@cloudflare/workers-types';
import { runDueAgents, type MessagesClient } from './agent-runner';
import { loadProviderKey, markProviderKeyRejected, workspacesWithWorkingKey } from './ai-provider-store';
import { clientFor } from './ai-providers';
import type { EmailProvider } from './email-provider';
import { draftDueFollowUps } from './follow-up';
import { sendDueBriefs } from './prep-brief';
import { importMasterKey } from './secret-box';

type AgentEnv = { DB: D1Database; AI_KEY_ENCRYPTION_KEY?: string };

/** Opens a workspace's own provider key, which an admin sets on the Admin page. Null without one. */
function keyedClients(env: AgentEnv, masterKey: CryptoKey) {
	return async (workspaceId: string): Promise<MessagesClient | null> => {
		try {
			const apiKey = await loadProviderKey(env.DB, masterKey, workspaceId, 'anthropic');
			return apiKey ? clientFor('anthropic', apiKey) : null;
		} catch (error) {
			// Most likely AI_KEY_ENCRYPTION_KEY changed since the key was saved.
			console.error('Could not open the workspace AI key', workspaceId, error);
			return null;
		}
	};
}

/**
 * Runs agents' waiting work on each workspace's own provider key. Workspaces
 * without one keep their runs waiting. The cron calls this every minute; a
 * note or an ask calls it at once so the agent starts straight away. Runs are
 * claimed first, so the two never do one twice.
 */
export async function runAgentsNow(env: AgentEnv, provider: EmailProvider | null, only?: string[]): Promise<void> {
	if (!env.AI_KEY_ENCRYPTION_KEY) return;
	const masterKey = await importMasterKey(env.AI_KEY_ENCRYPTION_KEY);
	const working = await workspacesWithWorkingKey(env.DB, 'anthropic');
	const workspaces = only ? working.filter((workspace) => only.includes(workspace)) : working;
	if (workspaces.length === 0) return;
	await runDueAgents(env.DB, {
		workspaces,
		provider,
		clientFor: keyedClients(env, masterKey),
		keyRejected: (workspaceId) => markProviderKeyRejected(env.DB, workspaceId, 'anthropic')
	});
}

/**
 * Sends the prep briefs that are due (demo spec, R11), then drafts the
 * follow-ups that are (R12). Without a working key a brief still goes out,
 * with everything but the suggested focus; a follow-up needs the key.
 */
export async function sendBriefsNow(env: AgentEnv, provider: EmailProvider, fetcher: typeof fetch = fetch): Promise<number> {
	const masterKey = env.AI_KEY_ENCRYPTION_KEY ? await importMasterKey(env.AI_KEY_ENCRYPTION_KEY) : null;
	const working = masterKey ? new Set(await workspacesWithWorkingKey(env.DB, 'anthropic')) : new Set<string>();
	const open = masterKey ? keyedClients(env, masterKey) : null;
	const clientFor = async (workspaceId: string) => (open && working.has(workspaceId) ? open(workspaceId) : null);
	const sent = await sendDueBriefs(env.DB, { provider, fetcher: (url, init) => fetcher(url, init), clientFor }, new Date());
	// After the meeting: follow-ups from your notes in reply to the brief (R12), for your OK.
	await draftDueFollowUps(env.DB, { clientFor }, new Date());
	return sent;
}
