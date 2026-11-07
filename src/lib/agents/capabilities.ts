/**
 * The fixed set of things an agent can ever do (docs/specs/agent-staff-platform.md, A6).
 * Agents, built-in or external, can only propose actions from this list; the
 * policy engine decides whether each one runs.
 */

export const CAPABILITIES = [
	'read_threads',
	'write_note',
	'draft_reply',
	'organize',
	'send_reply',
	'send_email',
	'set_timer',
	'calendar',
	'hand_off',
	'fetch_web',
	'propose_memory'
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export type AutonomyLevel = 'off' | 'approve' | 'auto';

export const AUTONOMY_LEVELS: readonly AutonomyLevel[] = ['off', 'approve', 'auto'];

type CapabilityTraits = {
	/** Only reads. Runs even in shadow mode, since an agent can't work blind. */
	readOnly: boolean;
	/** Can put mail in front of someone outside the workspace. */
	reachesOutside: boolean;
	/** Starting level for a newly hired agent. Never `auto` for anything that reaches outside. */
	defaultLevel: AutonomyLevel;
	/** An external agent may only run this on `auto` once it has earned it (external-agents.md, X2). */
	externalAutoNeedsTrackRecord: boolean;
};

export const CAPABILITY_TRAITS: Record<Capability, CapabilityTraits> = {
	read_threads: { readOnly: true, reachesOutside: false, defaultLevel: 'auto', externalAutoNeedsTrackRecord: false },
	write_note: { readOnly: false, reachesOutside: false, defaultLevel: 'auto', externalAutoNeedsTrackRecord: false },
	draft_reply: { readOnly: false, reachesOutside: false, defaultLevel: 'auto', externalAutoNeedsTrackRecord: false },
	organize: { readOnly: false, reachesOutside: false, defaultLevel: 'approve', externalAutoNeedsTrackRecord: false },
	send_reply: { readOnly: false, reachesOutside: true, defaultLevel: 'approve', externalAutoNeedsTrackRecord: true },
	send_email: { readOnly: false, reachesOutside: true, defaultLevel: 'approve', externalAutoNeedsTrackRecord: true },
	set_timer: { readOnly: false, reachesOutside: false, defaultLevel: 'auto', externalAutoNeedsTrackRecord: false },
	calendar: { readOnly: false, reachesOutside: true, defaultLevel: 'approve', externalAutoNeedsTrackRecord: true },
	hand_off: { readOnly: false, reachesOutside: false, defaultLevel: 'auto', externalAutoNeedsTrackRecord: false },
	fetch_web: { readOnly: true, reachesOutside: false, defaultLevel: 'auto', externalAutoNeedsTrackRecord: false },
	propose_memory: { readOnly: false, reachesOutside: false, defaultLevel: 'approve', externalAutoNeedsTrackRecord: false }
};

/** Approvals an external agent needs on a capability before `auto` takes effect for it. */
export const EXTERNAL_AUTO_MIN_APPROVALS = 20;

export function isCapability(value: unknown): value is Capability {
	return typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value);
}

export function isAutonomyLevel(value: unknown): value is AutonomyLevel {
	return typeof value === 'string' && (AUTONOMY_LEVELS as readonly string[]).includes(value);
}

/** Plain-language names for the Staff page. */
export const CAPABILITY_LABELS: Record<Capability, { name: string; hint: string }> = {
	read_threads: { name: 'Read threads', hint: 'See the mail it is working on' },
	write_note: { name: 'Write notes', hint: 'Leave private notes on a thread for you' },
	draft_reply: { name: 'Draft replies', hint: 'Write drafts you can send yourself' },
	organize: { name: 'Organize', hint: 'Label, archive, and move mail' },
	send_reply: { name: 'Send replies', hint: 'Reply to people already on the thread' },
	send_email: { name: 'Send new email', hint: 'Start new threads with people' },
	set_timer: { name: 'Set timers', hint: 'Come back to a thread later' },
	calendar: { name: 'Calendar', hint: 'Hold times and send invites' },
	hand_off: { name: 'Hand off', hint: 'Pass a thread to you or another agent' },
	fetch_web: { name: 'Fetch web pages', hint: 'Read public pages for context' },
	propose_memory: { name: 'Remember things', hint: 'Suggest facts to keep for later' }
};

export const AUTONOMY_LABELS: Record<AutonomyLevel, string> = {
	off: 'Off',
	approve: 'Ask me first',
	auto: 'On its own'
};
