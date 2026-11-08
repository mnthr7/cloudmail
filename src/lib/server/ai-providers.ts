import Anthropic from '@anthropic-ai/sdk';
import type { AiProvider } from '#lib/agents/providers.ts';
import type { MessagesClient } from './agent-runner.ts';

/** Talks to each AI provider: a client for agent runs, and a cheap check that a key works. */

export function clientFor(provider: AiProvider, apiKey: string): MessagesClient {
	switch (provider) {
		case 'anthropic': {
			const client = new Anthropic({ apiKey, maxRetries: 2 });
			return { create: (params) => client.beta.messages.create(params) };
		}
	}
}

export type KeyCheck = 'ok' | 'rejected' | 'unreachable';

/** Lists one model, which costs nothing, to see whether the provider accepts the key. */
export async function checkProviderKey(provider: AiProvider, apiKey: string): Promise<KeyCheck> {
	switch (provider) {
		case 'anthropic': {
			const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 15_000 });
			try {
				await client.models.list({ limit: 1 });
				return 'ok';
			} catch (error) {
				if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
					return 'rejected';
				}
				return 'unreachable';
			}
		}
	}
}

/** Whether an error from a run means the provider turned the key down. */
export function isKeyRejection(error: unknown): boolean {
	return error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError;
}
