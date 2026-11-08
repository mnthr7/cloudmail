import { AGENT_MODELS, type AgentModel } from './definition';

/**
 * AI providers a workspace can connect. Each one lists the agent models it
 * serves. Adding a provider means adding it here, to the migration's CHECK,
 * and a client in src/lib/server/ai-providers.ts.
 */
export const AI_PROVIDERS = ['anthropic'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const AI_PROVIDER_INFO: Record<AiProvider, { label: string; models: readonly AgentModel[]; keysUrl: string }> = {
	anthropic: {
		label: 'Anthropic',
		models: AGENT_MODELS,
		keysUrl: 'https://console.anthropic.com/settings/keys'
	}
};

export function isAiProvider(value: unknown): value is AiProvider {
	return typeof value === 'string' && (AI_PROVIDERS as readonly string[]).includes(value);
}

/** The provider that serves a model. */
export function providerForModel(model: AgentModel): AiProvider {
	for (const provider of AI_PROVIDERS) {
		if (AI_PROVIDER_INFO[provider].models.includes(model)) return provider;
	}
	return 'anthropic';
}
