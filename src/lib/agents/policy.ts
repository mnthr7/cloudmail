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
	/** For sends: the address the mail would go out from. One bare address, no display name. */
	fromAddress?: string;
	/** For sends and invites: everyone the mail would reach (to, cc, bcc). One bare address each. */
	recipients?: string[];
};

/** The exact addresses `authorize` allowed. Whatever carries the action out must use these, never the raw proposal. */
export type AuthorizedAddresses = { from: string | null; recipients: string[] };

export type PolicyContext = {
	status: AgentStatus;
	runtime: AgentRuntime;
	definition: AgentDefinition;
	/** Addresses already on the thread the proposal is about. */
	threadParticipants: string[];
	/** The workspace's human addresses. Agents may always write to them. */
	founderAddresses: string[];
	/**
	 * Addresses the author of the current definition may still hand out right
	 * now (their own, or any human's if they are still an admin). A send-as
	 * address that has since been deleted, moved to someone else, or put out of
	 * the author's reach stops working at once.
	 */
	sendableAddresses: string[];
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
	| 'invalid_address'
	| 'send_as_out_of_scope'
	| 'no_recipients'
	| 'recipient_out_of_scope'
	| 'daily_limit_reached';

export type PolicyDecision =
	| { outcome: 'execute'; reason: 'auto'; addresses: AuthorizedAddresses }
	| { outcome: 'queue'; reason: 'needs_approval' | 'external_track_record'; addresses: AuthorizedAddresses }
	| { outcome: 'shadow'; reason: 'shadow_mode'; addresses: AuthorizedAddresses }
	| { outcome: 'reject'; reason: RejectReason };

const ADDRESS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Exactly one bare address, lowercased, or null. No display names, brackets,
 * commas, quotes or whitespace: a string that a mail library might read as
 * more than one recipient is refused rather than parsed, so what is checked is
 * exactly what would be sent.
 */
export function strictAddress(value: unknown): string | null {
	if (typeof value !== 'string' || value.length > 254) return null;
	const address = value.trim().toLowerCase();
	return ADDRESS.test(address) ? address : null;
}

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

	const scoped = checkScope(capability, proposal, context);
	if ('reject' in scoped) return reject(scoped.reject);
	const addresses = scoped.addresses;

	if (setting.dailyLimit !== undefined && context.usedToday >= setting.dailyLimit) {
		return reject('daily_limit_reached');
	}

	if (context.status === 'shadow' && !traits.readOnly) {
		return { outcome: 'shadow', reason: 'shadow_mode', addresses };
	}

	if (setting.level === 'approve') return { outcome: 'queue', reason: 'needs_approval', addresses };

	if (
		context.runtime === 'external' &&
		traits.externalAutoNeedsTrackRecord &&
		context.humanApprovals < EXTERNAL_AUTO_MIN_APPROVALS
	) {
		return { outcome: 'queue', reason: 'external_track_record', addresses };
	}

	return { outcome: 'execute', reason: 'auto', addresses };
}

function checkScope(
	capability: Capability,
	proposal: Proposal,
	context: PolicyContext
): { addresses: AuthorizedAddresses } | { reject: RejectReason } {
	const sendsMail = SENDS_MAIL.has(capability);

	const recipients: string[] = [];
	for (const raw of proposal.recipients ?? []) {
		const address = strictAddress(raw);
		if (!address) return { reject: 'invalid_address' };
		if (!recipients.includes(address)) recipients.push(address);
	}

	let from: string | null = null;
	if (sendsMail || proposal.fromAddress !== undefined) {
		from = strictAddress(proposal.fromAddress);
		if (proposal.fromAddress !== undefined && !from) return { reject: 'invalid_address' };
		const sendable = new Set(context.sendableAddresses.map(strictAddress));
		if (!from || !context.definition.scope.sendAs.includes(from) || !sendable.has(from)) {
			return { reject: 'send_as_out_of_scope' };
		}
	}

	if (sendsMail && recipients.length === 0) return { reject: 'no_recipients' };

	if (recipients.length > 0) {
		// Context lists come from our own database, so lenient normalization is fine there.
		const allowed = new Set(
			[...context.threadParticipants, ...context.founderAddresses].map((value) => value.trim().toLowerCase())
		);
		const scope = context.definition.scope.recipients;
		const allowedDomains = scope.kind === 'domains' ? new Set(scope.domains) : null;

		for (const recipient of recipients) {
			if (allowed.has(recipient)) continue;
			const domain = recipient.slice(recipient.lastIndexOf('@') + 1);
			if (allowedDomains?.has(domain)) continue;
			return { reject: 'recipient_out_of_scope' };
		}
	}

	return { addresses: { from, recipients } };
}

function reject(reason: RejectReason): PolicyDecision {
	return { outcome: 'reject', reason };
}
