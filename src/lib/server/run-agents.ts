import type { D1Database } from '@cloudflare/workers-types';
import { runDueAgents } from './agent-runner';
import { loadProviderKey, markProviderKeyRejected, workspacesWithWorkingKey } from './ai-provider-store';
import { clientFor } from './ai-providers';
import type { EmailProvider } from './email-provider';
import { importMasterKey } from './secret-box';

/**
 * Runs agents' waiting work on each workspace's own provider key, which an admin
 * sets on the Admin page. Workspaces without one keep their runs waiting. The
 * cron calls this every minute; a note or an ask calls it at once so the agent
 * starts straight away. Runs are claimed first, so the two never do one twice.
 */
export async function runAgentsNow(
	env: { DB: D1Database; AI_KEY_ENCRYPTION_KEY?: string },
	provider: EmailProvider | null,
	only?: string[]
): Promise<void> {
	if (!env.AI_KEY_ENCRYPTION_KEY) return;
	const masterKey = await importMasterKey(env.AI_KEY_ENCRYPTION_KEY);
	const working = await workspacesWithWorkingKey(env.DB, 'anthropic');
	const workspaces = only ? working.filter((workspace) => only.includes(workspace)) : working;
	if (workspaces.length === 0) return;
	await runDueAgents(env.DB, {
		workspaces,
		provider,
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
