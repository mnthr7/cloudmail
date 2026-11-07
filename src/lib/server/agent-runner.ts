import Anthropic from '@anthropic-ai/sdk';
import type { D1Database } from '@cloudflare/workers-types';
import type { PolicyDecision } from '#lib/agents/policy.ts';
import { getAgent, liveWorkspaceAddresses, proposeAction } from './agents-store.ts';
import {
	buildUserMessage,
	costMicros,
	systemPrompt,
	threadParticipants,
	toolsFor,
	toProposal,
	type RunTrigger
} from './agent-brain.ts';
import {
	claimRuns,
	finishRun,
	MAX_RUN_ATTEMPTS,
	pauseForBudget,
	runHasProposals,
	spentThisMonth,
	type AgentRun,
	type RunUsage
} from './agent-runs-store.ts';
import { getEmailForUser, listThreadMessages } from './mail-store.ts';

/**
 * Carries out agent runs (docs/specs/agent-staff-platform.md, §8.2): loads the
 * agent and the thread, asks the model, and sends every tool call through
 * `proposeAction`. A run only ever records proposals. Nothing here sends mail
 * or changes the mailbox.
 */

/** The one call the runner makes, so tests can stand in for the API. */
export type MessagesClient = {
	create(params: Anthropic.Beta.MessageCreateParamsNonStreaming): Promise<Anthropic.Beta.BetaMessage>;
};

export function anthropicClient(apiKey: string): MessagesClient {
	const client = new Anthropic({ apiKey, maxRetries: 2 });
	return { create: (params) => client.beta.messages.create(params) };
}

/** Model calls per run. Enough to react to a refusal and finish, not enough to wander. */
const MAX_TURNS = 4;
/** Runs per cron tick. Each can take a minute or two, and ticks run every minute. */
export const RUNS_PER_TICK = 2;

function describe(decision: PolicyDecision): string {
	switch (decision.outcome) {
		case 'execute':
			return 'Allowed by your permissions and recorded.';
		case 'queue':
			return "Queued for the founder's approval. Nothing has happened yet.";
		case 'shadow':
			return 'Recorded as a shadow proposal. You are in shadow mode, so nothing was done; the founder will review it.';
		case 'reject':
			return `Refused by policy (${decision.reason}). Don't try to get around this.`;
	}
}

function retryable(error: unknown): boolean {
	if (error instanceof Anthropic.APIConnectionError) return true;
	if (error instanceof Anthropic.RateLimitError) return true;
	return error instanceof Anthropic.APIError && typeof error.status === 'number' && error.status >= 500;
}

export async function runDueAgents(
	db: D1Database,
	client: MessagesClient,
	options: { limit?: number; now?: () => Date } = {}
): Promise<number> {
	const now = options.now ?? (() => new Date());
	const runs = await claimRuns(db, options.limit ?? RUNS_PER_TICK, now());
	for (const run of runs) {
		try {
			await runOne(db, client, run, now);
		} catch (error) {
			console.error('Agent run failed', run.id, error);
			const again = retryable(error) && run.attempts < MAX_RUN_ATTEMPTS;
			const outcome =
				error instanceof Anthropic.AuthenticationError
					? 'api_key_invalid'
					: error instanceof Anthropic.APIError
						? `api_error_${error.status ?? 'connection'}`
						: 'error';
			await finishRun(db, run.id, { status: again ? 'pending' : 'failed', outcome }, now());
		}
	}
	return runs.length;
}

async function runOne(db: D1Database, client: MessagesClient, run: AgentRun, now: () => Date): Promise<void> {
	const skip = (outcome: string) => finishRun(db, run.id, { status: 'skipped', outcome }, now());

	const agent = await getAgent(db, run.agent_principal_id);
	if (!agent) return skip('agent_gone');
	if (agent.status === 'paused') return skip('paused');
	// A retry after the model already proposed something must not propose it twice.
	if (await runHasProposals(db, run.id)) {
		return finishRun(db, run.id, { status: 'done', outcome: 'already_proposed' }, now());
	}

	const definition = agent.version.definition;
	const budgetMicros = definition.monthlyBudgetCents * 10_000;
	if ((await spentThisMonth(db, agent.id, now())) >= budgetMicros) {
		await pauseForBudget(db, agent.id);
		return skip('budget_reached');
	}

	const tools = toolsFor(definition);
	if (tools.length === 0) return skip('no_tools');

	const email = await getEmailForUser(db, run.mailbox_user_id, run.email_id);
	if (!email || email.deleted_at) return skip('email_gone');
	const messages = await listThreadMessages(db, run.mailbox_user_id, email);
	if (messages.length === 0) return skip('email_gone');

	let trigger: RunTrigger = { kind: 'mail' };
	if (run.trigger_kind === 'ask') {
		const asker = run.requested_by_principal_id
			? await db
					.prepare(`SELECT display_name FROM principals WHERE id = ?`)
					.bind(run.requested_by_principal_id)
					.first<{ display_name: string | null }>()
			: null;
		trigger = { kind: 'ask', request: run.request ?? '', requestedBy: asker?.display_name || 'The founder' };
	}

	const founderAddresses = [...(await liveWorkspaceAddresses(db, agent.workspaceId)).keys()];
	const participants = threadParticipants(messages);
	const threadId = email.thread_id ?? email.id;
	const latest = messages[messages.length - 1];

	const conversation: Anthropic.Beta.BetaMessageParam[] = [
		{
			role: 'user',
			content: buildUserMessage({
				agentName: agent.displayName,
				definition,
				trigger,
				messages,
				triggerEmailId: run.email_id,
				founderAddresses
			})
		}
	];

	const usage: RunUsage = { model: definition.model, inputTokens: 0, outputTokens: 0, costMicros: 0 };
	let summary = '';
	let outcome = 'turn_limit';
	let proposals = 0;

	for (let turn = 0; turn < MAX_TURNS; turn++) {
		const response = await client.create({
			model: definition.model,
			max_tokens: 8000,
			system: [{ type: 'text', text: systemPrompt(), cache_control: { type: 'ephemeral' } }],
			messages: conversation,
			tools,
			tool_choice: { type: 'auto' },
			output_config: { effort: 'medium' },
			// A declined request is retried on the model Anthropic recommends for it.
			betas: ['server-side-fallback-2026-07-01'],
			fallbacks: 'default'
		});
		usage.inputTokens +=
			response.usage.input_tokens +
			(response.usage.cache_creation_input_tokens ?? 0) +
			(response.usage.cache_read_input_tokens ?? 0);
		usage.outputTokens += response.usage.output_tokens;
		usage.costMicros += costMicros(definition.model, response.usage);

		if (response.stop_reason === 'refusal') {
			outcome = 'refused';
			break;
		}

		const text = response.content
			.filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
			.map((block) => block.text)
			.join('\n')
			.trim();
		if (text) summary = text;

		const calls = response.content.filter(
			(block): block is Anthropic.Beta.BetaToolUseBlock => block.type === 'tool_use'
		);
		if (calls.length === 0) {
			outcome = response.stop_reason === 'max_tokens' ? 'max_tokens' : proposals ? 'proposed' : 'nothing_to_do';
			break;
		}

		// Append the whole response unchanged, so thinking blocks stay valid for the next turn.
		conversation.push({ role: 'assistant', content: response.content });
		const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
		for (const call of calls) {
			const proposal = toProposal(call.name, call.input, {
				threadId,
				emailId: latest.id,
				subject: latest.subject
			});
			if (!proposal) {
				results.push({
					type: 'tool_result',
					tool_use_id: call.id,
					is_error: true,
					content: 'That call was incomplete or used a tool you do not have.'
				});
				continue;
			}
			const result = await proposeAction(
				db,
				{
					agentId: agent.id,
					proposal: {
						capability: proposal.capability,
						fromAddress: proposal.fromAddress,
						recipients: proposal.recipients
					},
					threadId,
					payload: proposal.payload,
					reason: proposal.reason,
					threadParticipants: participants,
					runId: run.id
				},
				now()
			);
			proposals++;
			results.push({ type: 'tool_result', tool_use_id: call.id, content: describe(result.decision) });
		}
		conversation.push({ role: 'user', content: results });
	}

	await finishRun(
		db,
		run.id,
		{ status: 'done', outcome, summary, versionId: agent.version.id, usage },
		now()
	);
	if ((await spentThisMonth(db, agent.id, now())) >= budgetMicros) await pauseForBudget(db, agent.id);
}
