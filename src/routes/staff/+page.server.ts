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

export const load: PageServerLoad = async ({ locals, platform }) => {
	const empty: {
		agents: AgentSummary[];
		queue: QueuedAction[];
		shadow: ShadowAction[];
		runs: RunSummary[];
		spend: Record<string, number>;
		sendAs: string[];
		/** Whether an Anthropic API key is set, so agents actually run. */
		agentsEnabled: boolean;
		demo: boolean;
	} = { agents: [], queue: [], shadow: [], runs: [], spend: {}, sendAs: [], agentsEnabled: false, demo: false };

	// Demo mode is server-env only (DEMO_MODE="true"), never a URL param.
	if (DEMO_MODE && locals.user?.id === DEMO_USER.id) return { ...empty, demo: true };

	const db = platform?.env.DB;
	if (!db || !locals.user) return empty;

	const [agents, queue, shadow, runs, spend, sendAs] = await Promise.all([
		listAgents(db, locals.user.id),
		listQueuedActions(db, locals.user.id),
		listShadowActions(db, locals.user.id),
		listRecentRuns(db, locals.user.id),
		spendByAgent(db, locals.user.id),
		sendAsChoices(db, locals.user.id)
	]);
	return {
		agents,
		queue,
		shadow,
		runs,
		spend,
		sendAs,
		agentsEnabled: Boolean(platform?.env.ANTHROPIC_API_KEY),
		demo: false
	};
};
