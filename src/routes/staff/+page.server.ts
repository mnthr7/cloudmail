import type { PageServerLoad } from './$types';
import { DEMO_MODE, DEMO_USER } from '#lib/server/demo.ts';
import {
	listAgents,
	listQueuedActions,
	sendAsChoices,
	type AgentSummary,
	type QueuedAction
} from '#lib/server/agents-store.ts';
import {
	inboundVolume,
	listRecentRuns,
	listShadowActions,
	runUsageByAgent,
	spendByAgent,
	taskPatterns,
	type RunSummary,
	type TaskPattern,
	type ShadowAction
} from '#lib/server/agent-runs-store.ts';
import { providerStatusForUser } from '#lib/server/ai-provider-store.ts';
import { suggestionStats, type SuggestionStats } from '#lib/server/reply-suggestions-store.ts';
import { memoryByAgent, type MemoryFact } from '#lib/server/agent-memory-store.ts';
import { SPECIALIST_AFTER } from '#lib/agents/sam.ts';

export const load: PageServerLoad = async ({ locals, platform }) => {
	const empty: {
		agents: AgentSummary[];
		queue: QueuedAction[];
		shadow: ShadowAction[];
		runs: RunSummary[];
		spend: Record<string, number>;
		sendAs: string[];
		/** Whether agents can run: 'ready', no key yet, or the provider turned the key down. */
		aiKey: 'ready' | 'missing' | 'rejected';
		isAdmin: boolean;
		/** Average tokens per run over the last 30 days, per agent, for cost estimates. */
		usage: Record<string, { inputTokens: number; outputTokens: number; runs: number }>;
		/** Mail received at each address over the last 30 days. */
		volume: Record<string, number>;
		/** What the user did with each agent's suggested replies over the last 30 days. */
		suggestions: SuggestionStats[];
		/** Each agent's remembered facts. */
		memory: Record<string, MemoryFact[]>;
		/** Kinds of task a generalist keeps getting: candidates for a specialist. */
		patterns: TaskPattern[];
		demo: boolean;
	} = {
		memory: {},
		patterns: [],
		usage: {},
		volume: {},
		suggestions: [],
		agents: [],
		queue: [],
		shadow: [],
		runs: [],
		spend: {},
		sendAs: [],
		aiKey: 'missing',
		isAdmin: false,
		demo: false
	};

	// Demo mode is server-env only (DEMO_MODE="true"), never a URL param.
	if (DEMO_MODE && locals.user?.id === DEMO_USER.id) return { ...empty, demo: true };

	const db = platform?.env.DB;
	if (!db || !locals.user) return empty;

	const [agents, queue, shadow, runs, spend, sendAs, providers] = await Promise.all([
		listAgents(db, locals.user.id),
		listQueuedActions(db, locals.user.id),
		listShadowActions(db, locals.user.id),
		listRecentRuns(db, locals.user.id),
		spendByAgent(db, locals.user.id),
		sendAsChoices(db, locals.user.id),
		providerStatusForUser(db, locals.user.id).catch(() => [])
	]);
	const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
	const watchable = [...new Set([...sendAs, ...agents.flatMap((agent) => agent.definition.triggers.watch)])];
	const [usage, volume, suggestions, memory, patterns] = await Promise.all([
		runUsageByAgent(db, locals.user.id, since).catch(() => empty.usage),
		inboundVolume(db, locals.user.id, watchable, since).catch(() => empty.volume),
		suggestionStats(db, locals.user.id, since).catch(() => []),
		memoryByAgent(db, agents.map((agent) => agent.id)).catch(() => empty.memory),
		taskPatterns(db, locals.user.id, since, SPECIALIST_AFTER).catch(() => [])
	]);
	const key = providers.find((row) => row.provider === 'anthropic');
	const aiKey: 'ready' | 'missing' | 'rejected' =
		!key || !platform?.env.AI_KEY_ENCRYPTION_KEY ? 'missing' : key.rejectedAt ? 'rejected' : 'ready';
	return {
		agents,
		queue,
		shadow,
		runs,
		spend,
		sendAs,
		aiKey,
		isAdmin: Boolean(locals.user.is_admin),
		usage,
		volume,
		memory,
		patterns,
		suggestions,
		demo: false
	};
};
