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
	listRecentRuns,
	listShadowActions,
	spendByAgent,
	type RunSummary,
	type ShadowAction
} from '#lib/server/agent-runs-store.ts';
import { providerStatusForUser } from '#lib/server/ai-provider-store.ts';

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
		demo: boolean;
	} = {
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
		demo: false
	};
};
