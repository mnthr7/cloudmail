import { domainOf, parseEmailAddress } from '$lib/email-address';
import {
	CAPABILITY_TRAITS,
	EXTERNAL_AUTO_MIN_APPROVALS,
	isCapability,
	type Capability
} from './capabilities';
import type { AgentDefinition } from './definition';

/**
 * The policy engine (docs/specs/agent-staff-platform.md, §8.2). Every action
 * any agent proposes — built-in, external over MCP, or over A2A — goes through
 * `authorize`. It is pure: the caller loads the state, this decides, and nothing
 * the model says can change the answer.
 */

export type AgentStatus = 'shadow' | 'active' | 'paused';
export type AgentRuntime = 'builtin' | 'external';

export type Proposal = {
	/** Untrusted: comes from the model, so it is checked against the catalog. */
	capability: string;
	/** For sends: the address the mail would go out from. */
	fromAddress?: string;
	/** For sends and invites: everyone the mail would reach (to, cc, bcc). */
	recipients?: string[];
};

export type PolicyContext = {
	status: AgentStatus;
	runtime: AgentRuntime;
	definition: AgentDefinition;
	/** Addresses already on the thread the proposal is about. */
	threadParticipants: string[];
	/** The workspace's human addresses. Agents may always write to them. */
	founderAddresses: string[];
	/** Times this capability was allowed to run today (UTC). */
	usedToday: number;
	/** Times a human approved this capability for this agent. */
	humanApprovals: number;
	/** A human took the thread over, so the agent stands down (A13). */
	threadTakenOver?: boolean;
};

export type RejectReason =
	| 'agent_paused'
	| 'unknown_capability'
	| 'capability_off'
	| 'thread_taken_over'
	| 'send_as_out_of_scope'
	| 'no_recipients'
	| 'recipient_out_of_scope'
	| 'daily_limit_reached';

export type PolicyDecision =
	| { outcome: 'execute'; reason: 'auto' }
	| { outcome: 'queue'; reason: 'needs_approval' | 'external_track_record' }
	| { outcome: 'shadow'; reason: 'shadow_mode' }
	| { outcome: 'reject'; reason: RejectReason };

/** Capabilities that send mail on a thread or to new people, so they need a sender and recipients. */
const SENDS_MAIL: ReadonlySet<Capability> = new Set(['send_reply', 'send_email']);

export function authorize(proposal: Proposal, context: PolicyContext): PolicyDecision {
	if (context.status === 'paused') return reject('agent_paused');
	if (!isCapability(proposal.capability)) return reject('unknown_capability');

	const capability = proposal.capability;
	const traits = CAPABILITY_TRAITS[capability];
	const setting = context.definition.capabilities[capability];
	if (!setting || setting.level === 'off') return reject('capability_off');

	if (context.threadTakenOver && !traits.readOnly) return reject('thread_taken_over');

	const scopeProblem = checkScope(capability, proposal, context);
	if (scopeProblem) return reject(scopeProblem);

	if (setting.dailyLimit !== undefined && context.usedToday >= setting.dailyLimit) {
		return reject('daily_limit_reached');
	}

	if (context.status === 'shadow' && !traits.readOnly) {
		return { outcome: 'shadow', reason: 'shadow_mode' };
	}

	if (setting.level === 'approve') return { outcome: 'queue', reason: 'needs_approval' };

	if (
		context.runtime === 'external' &&
		traits.externalAutoNeedsTrackRecord &&
		context.humanApprovals < EXTERNAL_AUTO_MIN_APPROVALS
	) {
		return { outcome: 'queue', reason: 'external_track_record' };
	}

	return { outcome: 'execute', reason: 'auto' };
}

function checkScope(
	capability: Capability,
	proposal: Proposal,
	context: PolicyContext
): RejectReason | null {
	const sendsMail = SENDS_MAIL.has(capability);
	const recipients = (proposal.recipients ?? []).map(parseEmailAddress);

	if (sendsMail || proposal.fromAddress !== undefined) {
		const from = proposal.fromAddress ? parseEmailAddress(proposal.fromAddress) : '';
		if (!context.definition.scope.sendAs.includes(from)) return 'send_as_out_of_scope';
	}

	if (sendsMail && recipients.length === 0) return 'no_recipients';

	if (recipients.length > 0) {
		const allowed = new Set(
			[...context.threadParticipants, ...context.founderAddresses].map(parseEmailAddress)
		);
		const scope = context.definition.scope.recipients;
		const allowedDomains = scope.kind === 'domains' ? new Set(scope.domains) : null;

		for (const recipient of recipients) {
			if (allowed.has(recipient)) continue;
			const domain = domainOf(recipient);
			if (allowedDomains && domain && allowedDomains.has(domain)) continue;
			return 'recipient_out_of_scope';
		}
	}

	return null;
}

function reject(reason: RejectReason): PolicyDecision {
	return { outcome: 'reject', reason };
}
