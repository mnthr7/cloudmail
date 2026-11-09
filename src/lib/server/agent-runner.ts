import Anthropic from '@anthropic-ai/sdk';
import type { D1Database } from '@cloudflare/workers-types';
import type { PolicyDecision } from '#lib/agents/policy.ts';
import { supportsServerFallback } from '#lib/agents/models.ts';
import { getAgent, liveWorkspaceAddresses, proposeAction } from './agents-store.ts';
import {
	buildUserMessage,
	costMicros,
	systemPrompt,
	threadParticipants,
	SUGGEST_TOOL,
	toolsFor,
	toProposal,
	toSuggestion,
	verifiedContext,
	type RunTrigger
} from './agent-brain.ts';
import {
	addRunUsage,
	claimRuns,
	finishRun,
	MAX_RUN_ATTEMPTS,
	pauseForBudget,
	requeueRun,
	runHasProposals,
	spentThisMonth,
	type AgentRun,
	type RunUsage
} from './agent-runs-store.ts';
import { getEmailForUser, listThreadMessages } from './mail-store.ts';
import { saveSuggestions } from './reply-suggestions-store.ts';

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

/**
 * Where runs get their model client: each workspace uses its own provider key.
 * `workspaces` lists those with a working key; runs elsewhere stay waiting.
 */
export type RunClients = {
	workspaces: string[];
	clientFor(workspaceId: string): Promise<MessagesClient | null>;
	/** The provider turned the workspace's key down. */
	keyRejected?(workspaceId: string): Promise<void>;
};

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

/**
 * Only a 401 means the key itself is bad. A 403 can be about one request (a
 * model or feature the account can't use), so it fails that run, not the workspace.
 */
function keyRejected(error: unknown): boolean {
	return error instanceof Anthropic.AuthenticationError;
}

/** What the provider said, for the run's outcome and the logs. Never includes the key. */
function describeError(error: unknown): string {
	if (error instanceof Anthropic.APIError) {
		const type = (error.error as { error?: { type?: string } } | undefined)?.error?.type;
		return `api_error_${error.status ?? 'connection'}${type ? ` ${type}` : ''}: ${error.message}`;
	}
	return error instanceof Error ? `error: ${error.message}` : 'error';
}

export async function runDueAgents(
	db: D1Database,
	clients: RunClients,
	options: { limit?: number; now?: () => Date } = {}
): Promise<number> {
	const now = options.now ?? (() => new Date());
	const runs = await claimRuns(db, options.limit ?? RUNS_PER_TICK, now(), clients.workspaces);
	// One client per workspace per tick. Null once a workspace's key is missing or turned down.
	const cache = new Map<string, MessagesClient | null>();
	for (const run of runs) {
		if (!cache.has(run.workspace_id)) cache.set(run.workspace_id, await clients.clientFor(run.workspace_id));
		const client = cache.get(run.workspace_id);
		if (!client) {
			await requeueRun(db, run.id, 'no_key');
			continue;
		}
		try {
			await runOne(db, client, run, now);
		} catch (error) {
			if (keyRejected(error)) {
				// Not the run's fault: it waits until an admin saves a working key.
				console.error('AI provider turned down the workspace key', run.workspace_id, describeError(error));
				cache.set(run.workspace_id, null);
				await clients.keyRejected?.(run.workspace_id);
				await requeueRun(db, run.id, 'api_key_invalid');
				continue;
			}
			const outcome = describeError(error);
			console.error('Agent run failed', run.id, outcome);
			const again = retryable(error) && run.attempts < MAX_RUN_ATTEMPTS;
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

	let trigger: RunTrigger = { kind: 'mail' };
	if (run.trigger_kind === 'ask') {
		const asker = run.requested_by_principal_id
			? await db
					.prepare(`SELECT display_name FROM principals WHERE id = ?`)
					.bind(run.requested_by_principal_id)
					.first<{ display_name: string | null }>()
			: null;
		const requestedBy = asker?.display_name || 'The founder';
		// An ask without a request is a request for reply options.
		trigger = run.request ? { kind: 'ask', request: run.request, requestedBy } : { kind: 'suggest', requestedBy };
	}

	const tools = toolsFor(definition, trigger.kind);
	if (tools.length === 0) return skip('no_tools');

	const email = await getEmailForUser(db, run.mailbox_user_id, run.email_id);
	if (!email || email.deleted_at) return skip('email_gone');
	const thread = await listThreadMessages(db, run.mailbox_user_id, email);
	// New mail only sees the part of the thread it provably belongs to.
	const messages = verifiedContext(thread, email, run.trigger_kind);
	if (messages.length === 0) return skip('email_gone');

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

	let spent = await spentThisMonth(db, agent.id, now());
	let summary = '';
	let outcome = 'turn_limit';
	let proposals = 0;
	let suggested = false;

	for (let turn = 0; turn < MAX_TURNS; turn++) {
		// Checked before every call, not only at the start, so one run can't run far past the cap.
		if (spent >= budgetMicros) {
			outcome = 'budget_reached';
			await pauseForBudget(db, agent.id);
			break;
		}
		const response = await client.create({
			model: definition.model,
			max_tokens: 8000,
			system: [{ type: 'text', text: systemPrompt(), cache_control: { type: 'ephemeral' } }],
			messages: conversation,
			tools,
			tool_choice: { type: 'auto' },
			output_config: { effort: 'medium' },
			// A declined request is retried on the model Anthropic recommends for it.
			// Haiku has no server-side fallback, and a request asking for one fails.
			...(supportsServerFallback(definition.model)
				? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
				: {})
		});
		// Saved at once, so a failure later in the run can't make this call free.
		const usage: RunUsage = {
			model: definition.model,
			inputTokens:
				response.usage.input_tokens +
				(response.usage.cache_creation_input_tokens ?? 0) +
				(response.usage.cache_read_input_tokens ?? 0),
			outputTokens: response.usage.output_tokens,
			costMicros: costMicros(definition.model, response.usage)
		};
		await addRunUsage(db, run.id, usage);
		spent += usage.costMicros;

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
			outcome =
				response.stop_reason === 'max_tokens'
					? 'max_tokens'
					: proposals
						? 'proposed'
						: suggested
							? 'suggested'
							: 'nothing_to_do';
			break;
		}

		// Append the whole response unchanged, so thinking blocks stay valid for the next turn.
		conversation.push({ role: 'assistant', content: response.content });
		const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
		let suggestedThisTurn = 0;
		for (const call of calls) {
			if (call.name === SUGGEST_TOOL.name && tools.includes(SUGGEST_TOOL)) {
				const suggestion = toSuggestion(call.input);
				if (!suggestion) {
					results.push({
						type: 'tool_result',
						tool_use_id: call.id,
						is_error: true,
						content: 'Give the intent, whether a reply is needed, and at least one complete reply when it is.'
					});
					continue;
				}
				await saveSuggestions(
					db,
					{
						workspaceId: agent.workspaceId,
						agentId: agent.id,
						runId: run.id,
						mailboxUserId: run.mailbox_user_id,
						emailId: run.email_id,
						threadId,
						intent: suggestion.intent,
						replyNeeded: suggestion.replyNeeded,
						options: suggestion.options,
						model: definition.model
					},
					now()
				);
				suggested = true;
				suggestedThisTurn++;
				summary = suggestion.replyNeeded
					? `Suggested ${suggestion.options.length} ${suggestion.options.length === 1 ? 'reply' : 'replies'}: ${suggestion.intent}`
					: `No reply needed: ${suggestion.intent}`;
				results.push({
					type: 'tool_result',
					tool_use_id: call.id,
					content: suggestion.replyNeeded
						? 'Saved. The founder sees these on the thread and picks one, edits it, or ignores them.'
						: 'Saved. The founder sees that no reply is needed.'
				});
				continue;
			}
			// Only the tools offered this run count, whatever the model calls.
			const offered = tools.some((tool) => tool.name === call.name);
			const proposal = offered && toProposal(call.name, call.input, {
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
					runId: run.id,
					mailboxUserId: run.mailbox_user_id
				},
				now()
			);
			proposals++;
			results.push({ type: 'tool_result', tool_use_id: call.id, content: describe(result.decision) });
		}
		// Suggesting was the whole job this turn: another call would only cost money to say so.
		if (suggestedThisTurn === calls.length) {
			outcome = 'suggested';
			break;
		}
		conversation.push({ role: 'user', content: results });
	}

	await finishRun(
		db,
		run.id,
		{ status: 'done', outcome, summary, versionId: agent.version.id },
		now()
	);
	if (spent >= budgetMicros) await pauseForBudget(db, agent.id);
}
