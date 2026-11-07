import type { PageServerLoad } from './$types';
import { DEMO_MODE, DEMO_USER } from '$lib/server/demo';
import {
	listAgents,
	listQueuedActions,
	sendAsChoices,
	type AgentSummary,
	type QueuedAction
} from '$lib/server/agents-store';

export const load: PageServerLoad = async ({ locals, platform }) => {
	const empty: { agents: AgentSummary[]; queue: QueuedAction[]; sendAs: string[]; demo: boolean } = {
		agents: [],
		queue: [],
		sendAs: [],
		demo: false
	};

	// Demo mode is server-env only (DEMO_MODE="true"), never a URL param.
	if (DEMO_MODE && locals.user?.id === DEMO_USER.id) return { ...empty, demo: true };

	const db = platform?.env.DB;
	if (!db || !locals.user) return empty;

	const [agents, queue, sendAs] = await Promise.all([
		listAgents(db, locals.user.id),
		listQueuedActions(db, locals.user.id),
		sendAsChoices(db, locals.user.id)
	]);
	return { agents, queue, sendAs, demo: false };
};
