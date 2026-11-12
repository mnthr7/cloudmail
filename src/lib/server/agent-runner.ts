import Anthropic from '@anthropic-ai/sdk';
import { parseSecurity } from '#lib/security/phishing.ts';
import type { D1Database } from '@cloudflare/workers-types';
import type { PolicyDecision } from '#lib/agents/policy.ts';
import { supportsServerFallback } from '#lib/agents/models.ts';
import { getAgent, liveWorkspaceAddresses, proposeAction } from './agents-store.ts';
import {
	buildUserMessage,
	costMicros,
	systemPrompt,
	threadParticipants,
	LOG_TASK_TOOL,
	SUGGEST_TOOL,
	toolsFor,
	toTaskLabel,
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
import { executeAction, type ExecuteResult } from './agent-executor.ts';
import { isThreadTakenOver } from './thread-activity-store.ts';
import { listMemory } from './agent-memory-store.ts';
import { bookingsForGuest, checkMoveTime, senderVerified } from './booking-manage.ts';
import type { EmailProvider } from './email-provider.ts';

/**
 * Carries out agent runs (docs/specs/agent-staff-platform.md, §8.2): loads the
 * agent and the thread, asks the model, and sends every tool call through
 * `proposeAction`. What the policy allows on its own is carried out at once
 * by the executor; everything else waits for a human.
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
	/** Sends calendar updates when an agent moves or cancels a booking. */
	provider?: EmailProvider | null;
	clientFor(workspaceId: string): Promise<MessagesClient | null>;
	/** The provider turned the workspace's key down. */
	keyRejected?(workspaceId: string): Promise<void>;
};

/** Model calls per run. Enough to react to a refusal and finish, not enough to wander. */
const MAX_TURNS = 4;
/** Runs per cron tick. Each can take a minute or two, and ticks run every minute. */
export const RUNS_PER_TICK = 2;

function describe(decision: PolicyDecision, executed?: ExecuteResult): string {
	switch (decision.outcome) {
		case 'execute':
			if (executed?.status === 'blocked') {
				return `Stopped by loop protection (${executed.error}). The founder was told. Don't retry.`;
			}
			if (executed?.status === 'failed') return `Allowed, but it couldn't be done (${executed.error}).`;
			return 'Done.';
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
			await runOne(db, client, run, now, clients.provider ?? null);
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

async function runOne(
	db: D1Database,
	client: MessagesClient,
	run: AgentRun,
	now: () => Date,
	provider: EmailProvider | null
): Promise<void> {
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

	// An ask someone made on the thread itself (not one read from a teammate's email).
	const directAsk = run.trigger_kind === 'ask' && run.trigger_ref === run.id && !!run.request && !!run.requested_by_principal_id;
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

	// Booking mode: the calendar is on and one of the owner's booking pages sends from this agent's address.
	const calendarOn = !!definition.capabilities.calendar && definition.capabilities.calendar.level !== 'off';
	const runsBookings =
		(trigger.kind === 'mail' || trigger.kind === 'ask') && calendarOn && definition.scope.sendAs.length > 0
			? !!(await db
					.prepare(
						`SELECT 1 AS ok FROM booking_pages WHERE user_id = ? AND lower(send_from) IN (SELECT value FROM json_each(?)) LIMIT 1`
					)
					.bind(run.mailbox_user_id, JSON.stringify(definition.scope.sendAs.map((address) => address.toLowerCase())))
					.first<{ ok: number }>())
			: false;
	const email = await getEmailForUser(db, run.mailbox_user_id, run.email_id);
	if (!email || email.deleted_at) return skip('email_gone');
	const thread = await listThreadMessages(db, run.mailbox_user_id, email);
	// New mail only sees the part of the thread it provably belongs to.
	const messages = verifiedContext(thread, email, run.trigger_kind);
	if (messages.length === 0) return skip('email_gone');

	const founderAddresses = [...(await liveWorkspaceAddresses(db, agent.workspaceId)).keys()];
	// Only a guest's mail can be about their booking: the message the run is about (the
	// new mail, or the guest's message you asked about, fixed when you asked).
	const ours = new Set(founderAddresses.map((address) => address.toLowerCase()));
	const guestMail = email.direction === 'inbound' && !ours.has(email.from_addr.toLowerCase()) ? email : null;
	const bookingMail = runsBookings && !!guestMail;
	const tools = toolsFor(definition, trigger.kind, { bookings: bookingMail });
	if (tools.length === 0) return skip('no_tools');
	const participants = threadParticipants(messages);
	const threadId = email.thread_id ?? email.id;
	const latest = messages[messages.length - 1];
	// A thread the owner took over gets no new-mail work. Asking still works: that's the owner's own instruction.
	if (run.trigger_kind === 'mail' && (await isThreadTakenOver(db, run.mailbox_user_id, threadId))) {
		return skip('taken_over');
	}

	// An agent running a booking page sees the sender's bookings: on new mail only once
	// their domain proved the mail is theirs; when a teammate asks, they vouch for it.
	const security = (guestMail as (typeof guestMail & { security_json?: string | null }) | null)?.security_json ?? null;
	// You vouch by asking, but not for mail CloudMail flagged as phishing or suspicious.
	const vouched = trigger.kind === 'ask' && parseSecurity(security)?.verdict == null;
	const booking =
		bookingMail && guestMail
			? {
					senderVerified: vouched || senderVerified(security, guestMail.from_addr),
					bookings: await bookingsForGuest(
						db,
						run.mailbox_user_id,
						{ from_addr: guestMail.from_addr, security_json: security },
						definition.scope.sendAs,
						now(),
						vouched
					)
				}
			: {};

	const [memory, recentTasks] = await Promise.all([
		listMemory(db, agent.id),
		definition.kind === 'generalist' ? recentTaskLabels(db, agent.id) : Promise.resolve([])
	]);

	const conversation: Anthropic.Beta.BetaMessageParam[] = [
		{
			role: 'user',
			content: buildUserMessage({
				agentName: agent.displayName,
				definition,
				trigger,
				messages,
				triggerEmailId: run.email_id,
				founderAddresses,
				memory: memory.map((item) => item.fact),
				recentTasks,
				...booking
			})
		}
	];

	let spent = await spentThisMonth(db, agent.id, now());
	let summary = '';
	let outcome = 'turn_limit';
	let proposals = 0;
	/** What this ask has already approved: one booking change and one reply. */
	const askApproved = new Set<string>();
	let suggested = false;
	let handedOff = false;

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
		let loggedThisTurn = 0;
		for (const call of calls) {
			if (call.name === LOG_TASK_TOOL.name && tools.includes(LOG_TASK_TOOL)) {
				const label = toTaskLabel(call.input);
				if (label) {
					await db.prepare(`UPDATE agent_runs SET task_label = ? WHERE id = ?`).bind(label, run.id).run();
					loggedThisTurn++;
				}
				results.push(
					label
						? { type: 'tool_result', tool_use_id: call.id, content: 'Logged.' }
						: { type: 'tool_result', tool_use_id: call.id, is_error: true, content: 'Give a 2–6 word label.' }
				);
				continue;
			}
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
			// Once it handed the thread to the founder, it's theirs: nothing else from this run.
			if (handedOff) {
				results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: 'You handed this thread to the founder. Stop here.' });
				continue;
			}
			// Only the tools offered this run count, whatever the model calls.
			const offered = tools.some((tool) => tool.name === call.name);
			const proposal = offered && toProposal(call.name, call.input, {
				threadId,
				// A booking change is about the mail that asked for it, whose sender was checked.
				emailId: (call.name === 'reschedule_booking' || call.name === 'cancel_booking') && guestMail ? guestMail.id : latest.id,
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
			// Handing over writes to the sender of the mail and copies the founder, from the agent's
			// own address. The model picks none of that.
			if (proposal.capability === 'hand_off') {
				const sender = ours.has(email.from_addr.toLowerCase()) ? null : email.from_addr.toLowerCase();
				const founder = await db
					.prepare(`SELECT address FROM addresses WHERE user_id = ? ORDER BY is_default DESC, address LIMIT 1`)
					.bind(run.mailbox_user_id)
					.first<{ address: string }>();
				const from = definition.scope.sendAs[0];
				proposal.payload = { ...proposal.payload, emailId: email.id };
				if (sender && from && founder) {
					proposal.fromAddress = from;
					proposal.recipients = [sender, founder.address.toLowerCase()];
				}
			}
			// The open times listed are a sample: check the exact time asked for before proposing it.
			if (call.name === 'reschedule_booking') {
				const payload = proposal.payload as { bookingId?: string; start?: unknown };
				const check = await checkMoveTime(db, run.mailbox_user_id, payload.bookingId ?? '', payload.start, now());
				if (!check.open) {
					results.push({
						type: 'tool_result',
						tool_use_id: call.id,
						is_error: true,
						content: check.nearest.length
							? `That time isn't open. The nearest open times are:\n${check.nearest.map((slot) => `${slot.start} = ${slot.label}`).join('\n')}`
							: "That time isn't open, and nothing is open near it."
					});
					continue;
				}
			}
			// A booking change you asked for on mail whose sender couldn't be checked: you
			// vouched by asking, so you see that and OK it yourself.
			const unverifiedChange =
				proposal.capability === 'calendar' && trigger.kind === 'ask' && !senderVerified(security, guestMail?.from_addr ?? '');
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
					reason: unverifiedChange
						? `Sender not verified: this email's domain didn't confirm it's from ${guestMail?.from_addr ?? 'the guest'}. ${proposal.reason ?? ''}`.trim()
						: proposal.reason,
					threadParticipants: participants,
					runId: run.id,
					mailboxUserId: run.mailbox_user_id,
					mustApprove: unverifiedChange,
					// Asked for in so many words, on the Ask form or in a note: that's the OK, for one
					// booking change and one reply per ask.
					askedBy:
						directAsk && !askApproved.has(proposal.capability) ? (run.requested_by_principal_id ?? undefined) : undefined
				},
				now()
			);
			proposals++;
			if (directAsk && result.decision.outcome === 'execute') askApproved.add(proposal.capability);
			if (proposal.capability === 'hand_off' && result.decision.outcome !== 'reject') handedOff = true;
			const executed =
				result.decision.outcome === 'execute' ? await executeAction(db, result.actionId, now(), { provider }) : undefined;
			results.push({ type: 'tool_result', tool_use_id: call.id, content: describe(result.decision, executed) });
		}
		// Suggesting or logging was all that was left: another call would only cost money to say so.
		if (suggestedThisTurn + loggedThisTurn === calls.length) {
			outcome = proposals ? 'proposed' : suggestedThisTurn || suggested ? 'suggested' : 'logged';
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

/** A generalist's most used task labels from the last 90 days, so it reuses them. */
async function recentTaskLabels(db: D1Database, agentId: string): Promise<string[]> {
	const { results } = await db
		.prepare(
			`SELECT task_label FROM agent_runs
			 WHERE agent_principal_id = ? AND task_label IS NOT NULL AND created_at >= ?
			 GROUP BY task_label ORDER BY COUNT(*) DESC, MAX(created_at) DESC LIMIT 30`
		)
		.bind(agentId, new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString())
		.all<{ task_label: string }>();
	return results.map((row) => row.task_label);
}
