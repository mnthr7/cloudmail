import type { D1Database } from '@cloudflare/workers-types';
import type { Slot } from '#lib/calendar/availability.ts';
import { textToHtml } from '#lib/agents/suggestions.ts';
import { proposeAction, type AgentRecord } from './agents-store.ts';
import { disclosureFooter } from './agent-executor.ts';
import { pageBySlug, slotsFor } from './booking-store.ts';
import { guestThreads } from './follow-up.ts';
import { saveDraft } from './mail-store.ts';
import { briefingAgent } from './prep-brief.ts';

/**
 * No-shows (docs/specs/demo-role-end-to-end.md, R13).
 *
 * Ten minutes after a meeting on a page an agent runs, Needs your OK asks
 * the host: did they show? "Yes" changes nothing. "No-show" stops the general
 * follow-up and queues a short "sorry we missed you" email to the guest,
 * offering three new times and the booking link. It waits for the host's OK
 * like every other email to a guest after a meeting, and expires when its
 * first offered time passes. With no answer in a day, it's taken that the
 * guest came, and nothing happens.
 *
 * The email is written from a fixed template and the page's real open
 * times, not by a model: there is nothing to make up.
 */

const MIN = 60_000;
/** How long after the scheduled end the question appears. */
export const ASK_AFTER_MS = 10 * MIN;
/** How long the question waits for an answer before it's taken that they came. */
export const ANSWER_WITHIN_MS = 24 * 60 * MIN;
const PAGE_SIZE = 200;
const MAX_SCANNED = 2000;
/** How far ahead new times are offered from. */
const OFFER_DAYS = 14;

export class CheckError extends Error {
	constructor(readonly code: 'missing' | 'answered' | 'expired' | 'answer') {
		super(code);
		this.name = 'CheckError';
	}
}

type DueRow = { id: string; user_id: string; start_at: string; end_at: string; send_from: string };

/** Asks about meetings that ended at least ten minutes ago, within the last day. Returns how many were asked. */
export async function askDueChecks(db: D1Database, now = new Date()): Promise<number> {
	const at = now.getTime();
	await expireChecks(db, now);
	const agents = new Map<string, Promise<AgentRecord | null>>();
	let asked = 0;
	let scanned = 0;
	let after = { end: '', id: '' };
	while (scanned < MAX_SCANNED) {
		const { results } = await db
			.prepare(
				`SELECT b.id, b.user_id, b.start_at, b.end_at, p.send_from
				 FROM bookings b
				 JOIN booking_pages p ON p.id = b.page_id
				 LEFT JOIN booking_checks c ON c.booking_id = b.id AND c.for_start = b.start_at
				 WHERE b.status = 'confirmed' AND p.send_from IS NOT NULL AND c.id IS NULL
				   AND b.end_at <= ? AND b.end_at > ?
				   AND (b.end_at > ? OR (b.end_at = ? AND b.id > ?))
				 ORDER BY b.end_at, b.id
				 LIMIT ?`
			)
			.bind(
				new Date(at - ASK_AFTER_MS).toISOString(),
				new Date(at - ANSWER_WITHIN_MS).toISOString(),
				after.end,
				after.end,
				after.id,
				PAGE_SIZE
			)
			.all<DueRow>();
		if (results.length === 0) break;
		scanned += results.length;
		after = { end: results[results.length - 1].end_at, id: results[results.length - 1].id };
		for (const row of results) {
			const key = `${row.user_id} ${row.send_from.toLowerCase()}`;
			if (!agents.has(key)) agents.set(key, briefingAgent(db, row.user_id, row.send_from));
			const agent = await agents.get(key)!;
			// Only pages an agent runs: the question is the agent's, and so is what follows.
			if (!agent) continue;
			const insert = await db
				.prepare(
					`INSERT OR IGNORE INTO booking_checks (id, booking_id, for_start, workspace_id, agent_principal_id, mailbox_user_id, status, asked_at, expires_at)
					 VALUES (?, ?, ?, ?, ?, ?, 'asked', ?, ?)`
				)
				.bind(
					crypto.randomUUID(),
					row.id,
					row.start_at,
					agent.workspaceId,
					agent.id,
					row.user_id,
					now.toISOString(),
					new Date(Date.parse(row.end_at) + ANSWER_WITHIN_MS).toISOString()
				)
				.run();
			if (insert.meta.changes) asked++;
		}
		if (results.length < PAGE_SIZE) break;
	}
	return asked;
}

/** Questions nobody answered in time: they came. */
export async function expireChecks(db: D1Database, now = new Date()): Promise<void> {
	await db
		.prepare(`UPDATE booking_checks SET status = 'assumed_showed' WHERE status = 'asked' AND expires_at <= ?`)
		.bind(now.toISOString())
		.run();
}

export type OpenCheck = {
	id: string;
	agentName: string;
	guestName: string;
	guestEmail: string;
	pageTitle: string;
	start: string;
	end: string;
	timezone: string;
	expiresAt: string;
};

/** The host's open questions, oldest meeting first. */
export async function listOpenChecks(db: D1Database, userId: string, now = new Date()): Promise<OpenCheck[]> {
	await expireChecks(db, now);
	const { results } = await db
		.prepare(
			`SELECT c.id, c.expires_at, coalesce(a.display_name, 'Your agent') AS agent_name,
			        b.guest_name, b.guest_email, b.start_at, b.end_at, p.title, p.timezone
			 FROM booking_checks c
			 JOIN bookings b ON b.id = c.booking_id
			 JOIN booking_pages p ON p.id = b.page_id
			 LEFT JOIN principals a ON a.id = c.agent_principal_id
			 WHERE c.mailbox_user_id = ? AND c.status = 'asked' AND c.expires_at > ?
			 ORDER BY b.start_at`
		)
		.bind(userId, now.toISOString())
		.all<{
			id: string;
			expires_at: string;
			agent_name: string;
			guest_name: string;
			guest_email: string;
			start_at: string;
			end_at: string;
			title: string;
			timezone: string;
		}>();
	return results.map((row) => ({
		id: row.id,
		agentName: row.agent_name,
		guestName: row.guest_name,
		guestEmail: row.guest_email,
		pageTitle: row.title,
		start: row.start_at,
		end: row.end_at,
		timezone: row.timezone,
		expiresAt: row.expires_at
	}));
}

type CheckRow = {
	id: string;
	booking_id: string;
	for_start: string;
	mailbox_user_id: string;
	agent_principal_id: string | null;
	guest_name: string;
	guest_email: string;
	guest_timezone: string | null;
	start_at: string;
	end_at: string;
	event_id: string | null;
	slug: string;
	title: string;
	page_timezone: string;
	send_from: string;
	site_origin: string | null;
	enabled: number;
	host_name: string | null;
};

/**
 * The host's answer. Only the host (the meeting's mailbox owner) can give it,
 * once, before it expires. Returns what happened.
 */
export async function answerCheck(
	db: D1Database,
	input: { checkId: string; userId: string; answer: unknown },
	now = new Date()
): Promise<{ status: 'showed' | 'no_show'; sorry: 'queued' | 'draft' | 'none' }> {
	if (input.answer !== 'showed' && input.answer !== 'no_show') throw new CheckError('answer');
	const answer = input.answer;
	const human = await db
		.prepare(`SELECT id FROM principals WHERE user_id = ? AND kind = 'human'`)
		.bind(input.userId)
		.first<{ id: string }>();
	const claim = await db
		.prepare(
			`UPDATE booking_checks SET status = ?, answered_at = ?, answered_by_principal_id = ?
			 WHERE id = ? AND mailbox_user_id = ? AND status = 'asked' AND expires_at > ?`
		)
		.bind(answer, now.toISOString(), human?.id ?? null, input.checkId, input.userId, now.toISOString())
		.run();
	if (!claim.meta.changes) {
		const current = await db
			.prepare(`SELECT status, expires_at FROM booking_checks WHERE id = ? AND mailbox_user_id = ?`)
			.bind(input.checkId, input.userId)
			.first<{ status: string; expires_at: string }>();
		if (!current) throw new CheckError('missing');
		throw new CheckError(current.status === 'asked' || current.status === 'assumed_showed' ? 'expired' : 'answered');
	}
	if (answer === 'showed') return { status: 'showed', sorry: 'none' };

	const row = await db
		.prepare(
			`SELECT c.id, c.booking_id, c.for_start, c.mailbox_user_id, c.agent_principal_id,
			        b.guest_name, b.guest_email, b.guest_timezone, b.start_at, b.end_at, b.event_id,
			        p.slug, p.title, p.timezone AS page_timezone, p.send_from, p.site_origin, p.enabled, u.name AS host_name
			 FROM booking_checks c
			 JOIN bookings b ON b.id = c.booking_id
			 JOIN booking_pages p ON p.id = b.page_id
			 JOIN users u ON u.id = c.mailbox_user_id
			 WHERE c.id = ?`
		)
		.bind(input.checkId)
		.first<CheckRow>();
	if (!row) return { status: 'no_show', sorry: 'none' };

	await stopGeneralFollowUp(db, row);
	const sorry = await queueSorry(db, row, now);
	if (sorry.ref) {
		await db.prepare(`UPDATE booking_checks SET sorry_ref = ? WHERE id = ?`).bind(sorry.ref, row.id).run();
	}
	return { status: 'no_show', sorry: sorry.kind };
}

/**
 * A general follow-up thanks them for their time, which makes no sense now:
 * it isn't drafted, and one waiting for the host's OK is withdrawn. A
 * follow-up from the host's own notes is theirs, and stays.
 */
async function stopGeneralFollowUp(db: D1Database, row: CheckRow): Promise<void> {
	const brief = await db
		.prepare(`SELECT id, follow_up, follow_up_ref FROM booking_briefs WHERE booking_id = ? AND for_start = ?`)
		.bind(row.booking_id, row.for_start)
		.first<{ id: string; follow_up: string | null; follow_up_ref: string | null }>();
	if (!brief) return;
	if (brief.follow_up === 'general' && brief.follow_up_ref) {
		await db
			.prepare(`UPDATE agent_actions SET status = 'expired', policy_reason = 'no_show' WHERE id = ? AND status = 'queued'`)
			.bind(brief.follow_up_ref)
			.run();
	}
	await db
		.prepare(
			`UPDATE booking_briefs SET follow_up = 'skipped_no_show'
			 WHERE id = ? AND (follow_up IS NULL OR follow_up = 'general')`
		)
		.bind(brief.id)
		.run();
}

/** Up to three open times on different days where possible, soonest first. */
export function pickOffers(slots: Slot[], count = 3): Slot[] {
	const picked: Slot[] = [];
	const days = new Set<string>();
	for (const slot of slots) {
		if (picked.length >= count) break;
		if (days.has(slot.date)) continue;
		days.add(slot.date);
		picked.push(slot);
	}
	for (const slot of slots) {
		if (picked.length >= count) break;
		if (!picked.includes(slot)) picked.push(slot);
	}
	return picked.sort((a, b) => a.start - b.start);
}

function offerLine(slot: Slot, zone: string): string {
	const format = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: zone, ...options }).format(new Date(slot.start));
	return `- ${format({ weekday: 'long', month: 'long', day: 'numeric' })}, ${format({ hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}`;
}

async function queueSorry(db: D1Database, row: CheckRow, now: Date): Promise<{ kind: 'queued' | 'draft' | 'none'; ref: string | null }> {
	if (!row.agent_principal_id) return { kind: 'none', ref: null };
	const agent = await briefingAgent(db, row.mailbox_user_id, row.send_from);
	if (!agent) return { kind: 'none', ref: null };

	const duration = Math.round((Date.parse(row.end_at) - Date.parse(row.start_at)) / MIN);
	let offers: Slot[] = [];
	const page = row.enabled ? await pageBySlug(db, row.slug) : null;
	if (page) {
		try {
			const withLength = { ...page, durations: [...new Set([...page.durations, duration])] };
			offers = pickOffers(await slotsFor(db, withLength, { from: now.getTime(), to: now.getTime() + OFFER_DAYS * 24 * 60 * MIN, duration }, now));
		} catch {
			offers = [];
		}
	}
	const zone = row.guest_timezone || row.page_timezone;
	const link = page && row.site_origin ? `${row.site_origin.replace(/\/+$/, '')}/book/${row.slug}` : null;
	const first = row.guest_name.trim().split(/\s+/)[0] || row.guest_name;
	const host = row.host_name?.trim() || 'us';
	const body = [
		`Hi ${first},`,
		'',
		`Sorry we missed you for ${row.title}. No problem at all, these things happen.`,
		'',
		...(offers.length
			? [
					`If you'd still like to meet with ${host}, here are a few times that work:`,
					'',
					...offers.map((slot) => offerLine(slot, zone)),
					'',
					link ? `You can book one of these, or any other open time, here: ${link}` : 'Reply with the one that suits you and I’ll set it up.'
				]
			: [link ? `If you'd still like to meet with ${host}, you can pick a new time here: ${link}` : 'If you’d still like to meet, reply and I’ll find a new time.']),
		'',
		'Best,',
		agent.displayName
	].join('\n');
	// A time-sensitive offer is never sent late: it waits only until its first time passes.
	const expiresAt = offers.length ? new Date(offers[0].start) : new Date(now.getTime() + 2 * 24 * 60 * MIN);
	const reason = `"Sorry we missed you" to ${row.guest_name}, because you marked "${row.title}" a no-show${offers.length ? `, offering ${offers.length} new ${offers.length === 1 ? 'time' : 'times'}` : ''}.`;

	const guest = row.guest_email.toLowerCase();
	const pageAddress = row.send_from.toLowerCase();
	const { anchor } = await guestThreads(db, row.mailbox_user_id, guest, pageAddress);
	if (anchor) {
		const threadId = anchor.thread_id ?? anchor.id;
		const subject = /^re:/i.test(anchor.subject.trim()) ? anchor.subject.trim() : `Re: ${anchor.subject.trim()}`;
		const result = await proposeAction(
			db,
			{
				agentId: agent.id,
				proposal: { capability: 'send_reply', fromAddress: pageAddress, recipients: [guest] },
				threadId,
				payload: { threadId, emailId: anchor.id, from: pageAddress, to: [guest], cc: [], subject, body, noShow: row.booking_id },
				reason,
				threadParticipants: [guest],
				mailboxUserId: row.mailbox_user_id,
				mustApprove: true,
				expiresAt
			},
			now
		);
		if (result.decision.outcome === 'queue') return { kind: 'queued', ref: result.actionId };
	}
	// No thread with the guest to reply on, or replies are off: a draft in the host's Drafts.
	const signed = `${body}\n\n${disclosureFooter(agent.displayName, row.host_name?.trim() || pageAddress)}`;
	const draftId = await saveDraft(db, row.mailbox_user_id, {
		from: pageAddress,
		to: guest,
		subject: `Sorry we missed you: ${row.title}`.slice(0, 200),
		bodyText: signed,
		bodyHtml: textToHtml(signed)
	});
	return { kind: 'draft', ref: draftId };
}
