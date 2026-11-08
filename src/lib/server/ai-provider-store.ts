import type { D1Database } from '@cloudflare/workers-types';
import { AI_PROVIDERS, type AiProvider } from '#lib/agents/providers.ts';
import { humanPrincipalForUser, NotAllowedError } from './agents-store.ts';
import type { KeyCheck } from './ai-providers.ts';
import { openSecret, sealSecret } from './secret-box.ts';

/**
 * A workspace's AI provider keys. Admins set them on the Admin page; agent runs
 * read them. A key is only ever decrypted to make a provider call, and never
 * leaves the server.
 */

export type ProviderStatus = {
	provider: AiProvider;
	/** Last four characters of the key. */
	hint: string;
	setBy: string | null;
	updatedAt: string;
	/** When the provider last turned the key down during a run, if it has since it was saved. */
	rejectedAt: string | null;
};

export class ProviderKeyError extends Error {
	constructor(readonly code: 'provider' | 'key' | 'rejected' | 'unreachable' | 'encryption') {
		super(code);
		this.name = 'ProviderKeyError';
	}
}

function sealContext(workspaceId: string, provider: AiProvider): string {
	return `workspace-ai-key:${workspaceId}:${provider}`;
}

async function requireAdmin(db: D1Database, userId: string) {
	const human = await humanPrincipalForUser(db, userId);
	if (human.is_admin !== 1) throw new NotAllowedError();
	return human;
}

export async function listProviderStatus(db: D1Database, workspaceId: string): Promise<ProviderStatus[]> {
	const { results } = await db
		.prepare(
			`SELECT k.provider, k.key_hint AS hint, p.display_name AS setBy, k.updated_at AS updatedAt, k.rejected_at AS rejectedAt
			 FROM workspace_ai_providers k LEFT JOIN principals p ON p.id = k.set_by_principal_id
			 WHERE k.workspace_id = ?
			 ORDER BY k.provider`
		)
		.bind(workspaceId)
		.all<ProviderStatus>();
	return results;
}

/** The provider status for the workspace the user belongs to. */
export async function providerStatusForUser(db: D1Database, userId: string): Promise<ProviderStatus[]> {
	const human = await humanPrincipalForUser(db, userId);
	return listProviderStatus(db, human.workspace_id);
}

/** Checks the key with the provider, then stores it encrypted. Replaces any key already set. */
export async function setProviderKey(
	db: D1Database,
	input: {
		userId: string;
		provider: unknown;
		apiKey: unknown;
		masterKey: CryptoKey | null;
		check: (provider: AiProvider, apiKey: string) => Promise<KeyCheck>;
	},
	now = new Date()
): Promise<ProviderStatus> {
	const human = await requireAdmin(db, input.userId);
	if (typeof input.provider !== 'string' || !(AI_PROVIDERS as readonly string[]).includes(input.provider)) {
		throw new ProviderKeyError('provider');
	}
	const provider = input.provider as AiProvider;
	const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
	if (apiKey.length < 20 || apiKey.length > 500 || /\s/.test(apiKey)) throw new ProviderKeyError('key');
	if (!input.masterKey) throw new ProviderKeyError('encryption');

	const check = await input.check(provider, apiKey);
	if (check !== 'ok') throw new ProviderKeyError(check);

	const sealed = await sealSecret(input.masterKey, apiKey, sealContext(human.workspace_id, provider));
	const hint = apiKey.slice(-4);
	const at = now.toISOString();
	await db.batch([
		db
			.prepare(
				`INSERT INTO workspace_ai_providers (workspace_id, provider, key_sealed, key_hint, set_by_principal_id, updated_at, rejected_at)
				 VALUES (?, ?, ?, ?, ?, ?, NULL)
				 ON CONFLICT (workspace_id, provider) DO UPDATE SET
				   key_sealed = excluded.key_sealed, key_hint = excluded.key_hint,
				   set_by_principal_id = excluded.set_by_principal_id, updated_at = excluded.updated_at, rejected_at = NULL`
			)
			.bind(human.workspace_id, provider, sealed, hint, human.id, at),
		db
			.prepare(
				`INSERT INTO workspace_ai_provider_events (id, workspace_id, provider, action, key_hint, by_principal_id, created_at)
				 VALUES (?, ?, ?, 'set', ?, ?, ?)`
			)
			.bind(crypto.randomUUID(), human.workspace_id, provider, hint, human.id, at)
	]);
	const status = (await listProviderStatus(db, human.workspace_id)).find((row) => row.provider === provider);
	if (!status) throw new Error('Provider key was not saved');
	return status;
}

export async function removeProviderKey(
	db: D1Database,
	input: { userId: string; provider: unknown },
	now = new Date()
): Promise<boolean> {
	const human = await requireAdmin(db, input.userId);
	if (typeof input.provider !== 'string' || !(AI_PROVIDERS as readonly string[]).includes(input.provider)) {
		throw new ProviderKeyError('provider');
	}
	const existing = await db
		.prepare(`SELECT key_hint FROM workspace_ai_providers WHERE workspace_id = ? AND provider = ?`)
		.bind(human.workspace_id, input.provider)
		.first<{ key_hint: string }>();
	if (!existing) return false;
	await db.batch([
		db
			.prepare(`DELETE FROM workspace_ai_providers WHERE workspace_id = ? AND provider = ?`)
			.bind(human.workspace_id, input.provider),
		db
			.prepare(
				`INSERT INTO workspace_ai_provider_events (id, workspace_id, provider, action, key_hint, by_principal_id, created_at)
				 VALUES (?, ?, ?, 'removed', ?, ?, ?)`
			)
			.bind(crypto.randomUUID(), human.workspace_id, input.provider, existing.key_hint, human.id, now.toISOString())
	]);
	return true;
}

/** Workspaces whose agents can run: a key is set and the provider hasn't turned it down. */
export async function workspacesWithWorkingKey(db: D1Database, provider: AiProvider): Promise<string[]> {
	const { results } = await db
		.prepare(`SELECT workspace_id FROM workspace_ai_providers WHERE provider = ? AND rejected_at IS NULL`)
		.bind(provider)
		.all<{ workspace_id: string }>();
	return results.map((row) => row.workspace_id);
}

/** Decrypts a workspace's key, for a provider call. Null if none is set. */
export async function loadProviderKey(
	db: D1Database,
	masterKey: CryptoKey,
	workspaceId: string,
	provider: AiProvider
): Promise<string | null> {
	const row = await db
		.prepare(`SELECT key_sealed FROM workspace_ai_providers WHERE workspace_id = ? AND provider = ?`)
		.bind(workspaceId, provider)
		.first<{ key_sealed: string }>();
	if (!row) return null;
	return openSecret(masterKey, row.key_sealed, sealContext(workspaceId, provider));
}

/** The provider turned the key down: its workspace's agents wait until an admin saves a new one. */
export async function markProviderKeyRejected(
	db: D1Database,
	workspaceId: string,
	provider: AiProvider,
	now = new Date()
): Promise<void> {
	const at = now.toISOString();
	const changed = await db
		.prepare(
			`UPDATE workspace_ai_providers SET rejected_at = ?
			 WHERE workspace_id = ? AND provider = ? AND rejected_at IS NULL`
		)
		.bind(at, workspaceId, provider)
		.run();
	if (!changed.meta.changes) return;
	await db
		.prepare(
			`INSERT INTO workspace_ai_provider_events (id, workspace_id, provider, action, key_hint, by_principal_id, created_at)
			 SELECT ?, workspace_id, provider, 'rejected', key_hint, NULL, ?
			 FROM workspace_ai_providers WHERE workspace_id = ? AND provider = ?`
		)
		.bind(crypto.randomUUID(), at, workspaceId, provider)
		.run();
}
