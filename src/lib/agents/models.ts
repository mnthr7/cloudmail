import type { AgentModel } from './definition';

/**
 * What each model costs and is good for, shared by the runner (actual cost)
 * and the Staff page (estimates). Prices are dollars per million tokens, which
 * is also micro-dollars per token.
 */
type Price = { input: number; output: number };

const PRICES: Record<AgentModel, { standard: Price; long?: { above: number; price: Price } }> = {
	'claude-opus-5-5': { standard: { input: 4, output: 20 } },
	'claude-sonnet-5-5': { standard: { input: 2, output: 10 } },
	// Haiku 5.5 has a second rate card for prompts over 100K tokens.
	'claude-haiku-5-5': {
		standard: { input: 0.1, output: 0.5 },
		long: { above: 100_000, price: { input: 0.5, output: 2.5 } }
	}
};

export const MODEL_NOTES: Record<AgentModel, string> = {
	'claude-opus-5-5': 'Best judgment on tricky threads. The most expensive.',
	'claude-sonnet-5-5': 'Strong, natural writing at half the price of Opus.',
	'claude-haiku-5-5': 'Fast and very cheap. Good for routine replies and triage.'
};

export function priceFor(model: AgentModel, promptTokens: number): Price {
	const card = PRICES[model];
	return card.long && promptTokens > card.long.above ? card.long.price : card.standard;
}

export type TokenUsage = {
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens?: number | null;
	cache_read_input_tokens?: number | null;
};

/** Cost of one response, in micro-dollars. Cache writes cost 1.25x input, reads 0.1x. */
export function costMicros(model: AgentModel, usage: TokenUsage): number {
	const written = usage.cache_creation_input_tokens ?? 0;
	const read = usage.cache_read_input_tokens ?? 0;
	const price = priceFor(model, usage.input_tokens + written + read);
	const input = usage.input_tokens + written * 1.25 + read * 0.1;
	return Math.ceil(input * price.input + usage.output_tokens * price.output);
}

/**
 * Whether Anthropic retries a declined request on another model for us.
 * Haiku 5.5 has no server-side fallback, and a request that asks for one fails.
 */
export function supportsServerFallback(model: AgentModel): boolean {
	return model !== 'claude-haiku-5-5';
}

/** What a typical run uses when an agent has no history yet: a thread and three short replies. */
export const TYPICAL_RUN = { inputTokens: 5000, outputTokens: 1500 };

/** Estimated cost of one run, in micro-dollars. */
export function estimateRunMicros(model: AgentModel, usage: { inputTokens: number; outputTokens: number }): number {
	return costMicros(model, { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens });
}

/** "0.1¢", "2¢", "$1.20": short enough for a picker. */
export function formatMicros(micros: number): string {
	const cents = micros / 10_000;
	if (cents < 0.1) return `${cents.toFixed(2)}¢`;
	if (cents < 1) return `${cents.toFixed(1)}¢`;
	if (cents < 100) return `${Math.round(cents * 10) / 10}¢`;
	return `$${(cents / 100).toFixed(2)}`;
}
