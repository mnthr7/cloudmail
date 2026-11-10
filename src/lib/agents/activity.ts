/** What agents did on a thread, as the reader shows it (docs/specs/agent-staff-platform.md, A12). */

export type ActivityState =
	| 'waiting'
	| 'done'
	| 'shadow'
	| 'declined'
	| 'expired'
	| 'refused'
	| 'failed'
	| 'stopped';

export type ThreadActivityItem =
	| {
			kind: 'action';
			id: string;
			agentName: string;
			capability: string;
			/** What it did or wants to do, in a line. */
			what: string;
			state: ActivityState;
			/** Why the agent did it. */
			reason: string;
			/** What woke the agent up, when a run did. */
			trigger: 'mail' | 'ask' | null;
			/** Who approved or declined it. */
			decidedBy: string | null;
			/** Policy refusal or why carrying it out failed. */
			detail: string | null;
			at: string;
	  }
	| {
			kind: 'note' | 'alert';
			id: string;
			/** Who wrote it: an agent, or a person on the team. */
			agentName: string | null;
			byHuman: boolean;
			body: string;
			at: string;
	  }
	| { kind: 'takeover'; by: string | null; at: string };

export type ThreadActivity = { items: ThreadActivityItem[]; takenOver: boolean };

const REFUSALS: Record<string, string> = {
	agent_paused: 'the agent was paused',
	capability_off: "it isn't allowed to do that",
	thread_taken_over: 'you took this thread over',
	send_as_out_of_scope: 'it may not send from that address',
	recipient_out_of_scope: 'that recipient is outside its scope',
	no_recipients: 'there was nobody to send to',
	invalid_address: 'an address was malformed',
	daily_limit_reached: 'it hit its daily limit',
	unknown_capability: "it tried something it can't do"
};

const FAILURES: Record<string, string> = {
	loop_auto_reply: 'the last message looks like an automatic reply',
	loop_recipient_flood: 'agents already wrote to this person several times today',
	loop_thread_runaway: 'too many agent messages without a reply from your side',
	agent_paused: 'the agent was paused',
	thread_taken_over: 'you took this thread over',
	email_gone: 'the message is gone',
	approved_before_execution: 'it was approved before actions could run',
	agent_in_shadow: 'the agent is in shadow mode now',
	needs_approval: 'its permissions changed, so it needs your OK now',
	agent_gone: 'the agent was removed'
};

/** One plain line for a policy refusal or a failure code. */
export function explainDetail(state: ActivityState, detail: string | null): string | null {
	if (!detail) return null;
	if (state === 'refused') return REFUSALS[detail] ?? detail;
	if (state === 'expired') return detail === 'thread_taken_over' ? 'you took this thread over' : null;
	return FAILURES[detail] ?? REFUSALS[detail] ?? detail;
}
