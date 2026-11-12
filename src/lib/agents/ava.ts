import { CAPABILITIES } from './capabilities';
import { parseDefinition, type AgentDefinition } from './definition';

/**
 * Ava, the Demos template (docs/specs/demo-role-end-to-end.md). She runs a
 * booking page: guests' replies come to her address, and she moves or cancels
 * their meeting when they ask, offers open times, and leaves the founder a
 * note for anything else. Nothing here is special to her beyond the job text
 * and starting settings: she's an ordinary agent with the calendar on.
 */

export const AVA_NAME = 'Ava';

export function avaJob(company: string): string {
	return `You're Ava, the scheduling assistant for ${company || 'the company'}. People book meetings with the founder through the booking page, and their replies come to you.

- If someone asks to move their meeting, move it with reschedule_booking to an open time that matches what they asked for, then reply to confirm the new time in their time zone.
- If no open time fits, reply offering two or three of the open times listed, in their time zone.
- If they ask to cancel, cancel it with cancel_booking, then reply to confirm and say they're welcome to book again.
- If they're running late, thank them and write a short note so the founder knows.
- If they ask to talk to a person, or you can't tell what they want, hand the thread to the founder with hand_off, saying why. Don't guess.
- For anything else (a question about the product, pricing, an agenda), don't answer it yourself: write a note for the founder with what they asked.
- Keep replies to a few short sentences, friendly and plain. Sign as Ava.
- Never promise anything about the product, prices or dates beyond what's in this job description.`;
}

/**
 * Moving and canceling bookings, and replies, wait for the founder's OK until
 * they switch them to on-its-own on the Staff page. Email is easy to forge, so
 * a person checks before a guest's meeting changes. Sending new email,
 * fetching pages and timers stay off.
 */
export function avaDefinition(address: string, company: string): AgentDefinition {
	const levels: Partial<Record<(typeof CAPABILITIES)[number], 'off' | 'approve' | 'auto'>> = {
		read_threads: 'auto',
		write_note: 'auto',
		draft_reply: 'auto',
		send_reply: 'approve',
		calendar: 'approve',
		organize: 'approve',
		propose_memory: 'approve',
		// Handing a thread to the founder sends only a fixed note CloudMail writes ("I'm looping in
		// Sada"), never the model's words, so it can happen at once: that's the point of escalating.
		hand_off: 'auto'
	};
	const capabilities: AgentDefinition['capabilities'] = {};
	for (const capability of CAPABILITIES) capabilities[capability] = { level: levels[capability] ?? 'off' };
	// A ceiling on calendar changes a day, so a flood of mail can't churn the calendar.
	capabilities.calendar = { level: 'approve', dailyLimit: 20 };
	return parseDefinition({
		kind: 'specialist',
		job: avaJob(company),
		capabilities,
		scope: { sendAs: [address], recipients: { kind: 'thread' } },
		triggers: { watch: [address], teamOnly: false },
		model: 'claude-sonnet-5-5'
	});
}
