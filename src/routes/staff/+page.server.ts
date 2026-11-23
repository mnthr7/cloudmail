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
import { listBookingPages } from '#lib/server/booking-store.ts';
import { listOpenChecks, type OpenCheck } from '#lib/server/no-show.ts';
import {
	connectionsForAgent,
	recentToolCalls,
	type AgentConnection,
	type AuditRow
} from '#lib/server/external-agents-store.ts';
import { recentDeliveries, type DeliveryLogRow } from '#lib/server/agent-webhooks.ts';

/** What the Staff page shows for an external agent: how it connects and what it called. */
export type ExternalDetail = {
	connections: Array<AgentConnection & { deliveries: DeliveryLogRow[] }>;
	audit: AuditRow[];
};

export const load: PageServerLoad = async ({ locals, platform, url }) => {
	const empty: {
		agents: AgentSummary[];
		queue: QueuedAction[];
		/** "Did they show?" questions about your meetings (R13). */
		checks: OpenCheck[];
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
		/** Booking pages Ava could run. */
		bookingPages: Array<{ id: string; title: string; slug: string; sendFrom: string | null }>;
		/** Connections, deliveries and tool calls of each external agent. */
		external: Record<string, ExternalDetail>;
		/** Where MCP clients connect, or null when agents can't connect here (no OAUTH_KV). */
		mcpUrl: string | null;
		/** Webhook secrets need the encryption key. */
		webhooksReady: boolean;
		demo: boolean;
	} = {
		external: {},
		mcpUrl: null,
		webhooksReady: false,
		bookingPages: [],
		memory: {},
		patterns: [],
		usage: {},
		volume: {},
		suggestions: [],
		agents: [],
		queue: [],
		checks: [],
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

	const [agents, queue, checks, shadow, runs, spend, sendAs, providers] = await Promise.all([
		listAgents(db, locals.user.id),
		listQueuedActions(db, locals.user.id),
		listOpenChecks(db, locals.user.id).catch(() => []),
		listShadowActions(db, locals.user.id),
		listRecentRuns(db, locals.user.id, 100),
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
	const bookingPages = (await listBookingPages(db, locals.user.id).catch(() => [])).map((page) => ({
		id: page.id,
		title: page.title,
		slug: page.slug,
		sendFrom: page.sendFrom
	}));
	const external: Record<string, ExternalDetail> = {};
	for (const agent of agents.filter((item) => item.runtime === 'external')) {
		const connections = await connectionsForAgent(db, agent.id).catch(() => []);
		external[agent.id] = {
			// Teammates who can't manage the agent see only what the Disconnect brake needs.
			connections: await Promise.all(
				connections.map(async (connection) =>
					agent.canManage
						? { ...connection, deliveries: await recentDeliveries(db, connection.id, 10).catch(() => []) }
						: {
								...connection,
								clientId: '',
								grantRef: null,
								webhookUrl: null,
								hasWebhookSecret: false,
								mailboxUserId: '',
								deliveries: []
							}
				)
			),
			audit: agent.canManage ? await recentToolCalls(db, agent.id, 50).catch(() => []) : []
		};
	}
	const key = providers.find((row) => row.provider === 'anthropic');
	const aiKey: 'ready' | 'missing' | 'rejected' =
		!key || !platform?.env.AI_KEY_ENCRYPTION_KEY ? 'missing' : key.rejectedAt ? 'rejected' : 'ready';
	return {
		agents,
		queue,
		checks,
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
		bookingPages,
		external,
		mcpUrl: (platform?.env as Env | undefined)?.OAUTH_KV ? `${url.origin}/mcp` : null,
		webhooksReady: !!platform?.env.AI_KEY_ENCRYPTION_KEY,
		demo: false
	};
};
