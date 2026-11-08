import type { D1Database } from '@cloudflare/workers-types';

/**
 * Reply suggestions (migrations/0018): two or three replies an agent writes
 * for a thread, which the mailbox owner sends as themselves or edits first.
 * Only the owner of the mailbox sees a set, and what they do with it is
 * recorded so an agent's suggestions can be judged.
 */

export type SuggestionOption = { label: string; body: string };

export type ReplySuggestion = {
	id: string;
	agentName: string;
	intent: string;
	replyNeeded: boolean;
	options: SuggestionOption[];
	/** The message the replies answer. */
	emailId: string;
	createdAt: string;
};

export const MAX_OPTIONS = 3;

export class SuggestionError extends Error {
	constructor(readonly code: 'missing' | 'option' | 'state') {
		super(code);
		this.name = 'SuggestionError';
	}
}

/** Stores a new set for a thread. Any open set the owner had for it is replaced. */
export async function saveSuggestions(
	db: D1Database,
	input: {
		workspaceId: string;
		agentId: string;
		runId: string | null;
		mailboxUserId: string;
		emailId: string;
		threadId: string;
		intent: string;
		replyNeeded: boolean;
		options: SuggestionOption[];
		model: string | null;
	},
	now = new Date()
): Promise<string> {
	const id = crypto.randomUUID();
	const at = now.toISOString();
	await db.batch([
		db
			.prepare(
				`UPDATE reply_suggestions SET status = 'replaced', decided_at = ?
				 WHERE mailbox_user_id = ? AND thread_id = ? AND status = 'open'`
			)
			.bind(at, input.mailboxUserId, input.threadId),
		db
			.prepare(
				`INSERT INTO reply_suggestions
				 (id, workspace_id, agent_principal_id, run_id, mailbox_user_id, email_id, thread_id, intent, reply_needed,
				  options_json, model, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				id,
				input.workspaceId,
				input.agentId,
				input.runId,
				input.mailboxUserId,
				input.emailId,
				input.threadId,
				input.intent.slice(0, 300),
				input.replyNeeded ? 1 : 0,
				JSON.stringify(input.options.slice(0, MAX_OPTIONS)),
				input.model,
				at
			)
	]);
	return id;
}

type Row = {
	id: string;
	agent_name: string;
	intent: string;
	reply_needed: number;
	options_json: string;
	email_id: string;
	created_at: string;
};

function parseOptions(json: string): SuggestionOption[] {
	try {
		const value = JSON.parse(json) as unknown;
		if (!Array.isArray(value)) return [];
		return value
			.filter(
				(item): item is SuggestionOption =>
					!!item && typeof item.label === 'string' && typeof item.body === 'string'
			)
			.slice(0, MAX_OPTIONS);
	} catch {
		return [];
	}
}

/** The open set for a thread in this user's mailbox, if there is one. */
export async function openSuggestion(
	db: D1Database,
	userId: string,
	threadId: string
): Promise<ReplySuggestion | null> {
	const row = await db
		.prepare(
			`SELECT s.id, p.display_name AS agent_name, s.intent, s.reply_needed, s.options_json, s.email_id, s.created_at
			 FROM reply_suggestions s JOIN principals p ON p.id = s.agent_principal_id
			 WHERE s.mailbox_user_id = ? AND s.thread_id = ? AND s.status = 'open'
			 ORDER BY s.created_at DESC LIMIT 1`
		)
		.bind(userId, threadId)
		.first<Row>();
	if (!row) return null;
	return {
		id: row.id,
		agentName: row.agent_name,
		intent: row.intent,
		replyNeeded: row.reply_needed === 1,
		options: parseOptions(row.options_json),
		emailId: row.email_id,
		createdAt: row.created_at
	};
}

/** How many replies are waiting on each thread, for the inbox list. */
export async function openSuggestionCounts(
	db: D1Database,
	userId: string,
	threadIds: string[]
): Promise<Map<string, number>> {
	const counts = new Map<string, number>();
	if (threadIds.length === 0) return counts;
	const { results } = await db
		.prepare(
			`SELECT thread_id, options_json FROM reply_suggestions
			 WHERE mailbox_user_id = ? AND status = 'open' AND reply_needed = 1
			   AND thread_id IN (SELECT value FROM json_each(?))`
		)
		.bind(userId, JSON.stringify(threadIds))
		.all<{ thread_id: string; options_json: string }>();
	for (const row of results) counts.set(row.thread_id, parseOptions(row.options_json).length);
	return counts;
}

export async function dismissSuggestion(db: D1Database, userId: string, id: string, now = new Date()): Promise<void> {
	const result = await db
		.prepare(
			`UPDATE reply_suggestions SET status = 'dismissed', decided_at = ?
			 WHERE id = ? AND mailbox_user_id = ? AND status = 'open'`
		)
		.bind(now.toISOString(), id, userId)
		.run();
	if (!result.meta.changes) throw new SuggestionError('missing');
}

function words(text: string): string[] {
	return text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
}

/**
 * How much of a suggestion the owner changed before sending: 0 sent as
 * written, 1 nothing kept. Word-level, so line breaks and punctuation don't count.
 */
export function editRatio(suggested: string, sent: string): number {
	const a = words(suggested).slice(0, 1500);
	const b = words(sent).slice(0, 1500);
	if (a.length === 0 && b.length === 0) return 0;
	if (a.length === 0 || b.length === 0) return 1;
	// Longest common subsequence of words, one row at a time.
	let previous = new Array<number>(b.length + 1).fill(0);
	for (const word of a) {
		const current = new Array<number>(b.length + 1).fill(0);
		for (let j = 1; j <= b.length; j++) {
			current[j] = word === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
		}
		previous = current;
	}
	const kept = previous[b.length];
	return Math.round((1 - kept / Math.max(a.length, b.length)) * 1000) / 1000;
}

/** The owner sent a reply built from option `index`. `sentText` is what they wrote, without signature or quote. */
export async function recordSuggestionSent(
	db: D1Database,
	userId: string,
	input: { suggestionId: string; index: number; sentText: string; sentEmailId: string | null },
	now = new Date()
): Promise<void> {
	const row = await db
		.prepare(`SELECT options_json, status FROM reply_suggestions WHERE id = ? AND mailbox_user_id = ?`)
		.bind(input.suggestionId, userId)
		.first<{ options_json: string; status: string }>();
	if (!row) throw new SuggestionError('missing');
	if (row.status !== 'open') throw new SuggestionError('state');
	const option = parseOptions(row.options_json)[input.index];
	if (!option) throw new SuggestionError('option');
	await db
		.prepare(
			`UPDATE reply_suggestions
			 SET status = 'sent', chosen_index = ?, edit_ratio = ?, sent_email_id = ?, decided_at = ?
			 WHERE id = ? AND mailbox_user_id = ? AND status = 'open'`
		)
		.bind(
			input.index,
			editRatio(option.body, input.sentText),
			input.sentEmailId,
			now.toISOString(),
			input.suggestionId,
			userId
		)
		.run();
}

/** Below this much change, a sent suggestion counts as sent as written. */
export const AS_WRITTEN_RATIO = 0.05;

export type SuggestionStats = {
	agentId: string;
	model: string | null;
	suggested: number;
	sent: number;
	asWritten: number;
	edited: number;
	dismissed: number;
	/** The user wrote their own reply instead. */
	ownReply: number;
	noReply: number;
	/** Average share changed, over sent suggestions. */
	avgEdit: number | null;
};

/**
 * What the user did with each agent's suggestions on their own mail since a
 * date, per agent and model. A reply whose send was undone back to a draft
 * doesn't count as sent.
 */
export async function suggestionStats(db: D1Database, userId: string, since: Date): Promise<SuggestionStats[]> {
	const { results } = await db
		.prepare(
			`SELECT s.agent_principal_id AS agentId, s.model,
			        SUM(CASE WHEN s.reply_needed = 1 THEN 1 ELSE 0 END) AS suggested,
			        SUM(CASE WHEN s.status = 'sent' AND e.status IS NOT NULL AND e.status != 'draft' THEN 1 ELSE 0 END) AS sent,
			        SUM(CASE WHEN s.status = 'sent' AND e.status IS NOT NULL AND e.status != 'draft' AND s.edit_ratio < ? THEN 1 ELSE 0 END) AS asWritten,
			        SUM(CASE WHEN s.status = 'dismissed' AND s.sent_email_id IS NULL THEN 1 ELSE 0 END) AS dismissed,
			        SUM(CASE WHEN s.status = 'dismissed' AND s.sent_email_id IS NOT NULL THEN 1 ELSE 0 END) AS ownReply,
			        SUM(CASE WHEN s.reply_needed = 0 THEN 1 ELSE 0 END) AS noReply,
			        AVG(CASE WHEN s.status = 'sent' AND e.status IS NOT NULL AND e.status != 'draft' THEN s.edit_ratio END) AS avgEdit
			 FROM reply_suggestions s LEFT JOIN emails e ON e.id = s.sent_email_id
			 WHERE s.mailbox_user_id = ? AND s.created_at >= ?
			 GROUP BY s.agent_principal_id, s.model`
		)
		.bind(AS_WRITTEN_RATIO, userId, since.toISOString())
		.all<Omit<SuggestionStats, 'edited'>>();
	return results.map((row) => ({
		...row,
		suggested: row.suggested ?? 0,
		sent: row.sent ?? 0,
		asWritten: row.asWritten ?? 0,
		edited: (row.sent ?? 0) - (row.asWritten ?? 0),
		dismissed: row.dismissed ?? 0,
		ownReply: row.ownReply ?? 0,
		noReply: row.noReply ?? 0,
		avgEdit: row.avgEdit === null ? null : Math.round(row.avgEdit * 100) / 100
	}));
}

/**
 * A reply went out on a thread. If it came from a suggestion, records which
 * option and how much was changed. Otherwise the user wrote their own, and the
 * open set is closed as dismissed with that reply attached.
 */
export async function recordReplyForSuggestions(
	db: D1Database,
	userId: string,
	input: { threadId: string; sentEmailId: string; suggestion?: { id?: unknown; index?: unknown; text?: unknown } },
	now = new Date()
): Promise<void> {
	const ref = input.suggestion;
	if (ref && typeof ref.id === 'string' && Number.isInteger(ref.index) && typeof ref.text === 'string') {
		await recordSuggestionSent(
			db,
			userId,
			{ suggestionId: ref.id, index: ref.index as number, sentText: ref.text.slice(0, 50_000), sentEmailId: input.sentEmailId },
			now
		);
		return;
	}
	await db
		.prepare(
			`UPDATE reply_suggestions SET status = 'dismissed', sent_email_id = ?, decided_at = ?
			 WHERE mailbox_user_id = ? AND thread_id = ? AND status = 'open'`
		)
		.bind(input.sentEmailId, now.toISOString(), userId, input.threadId)
		.run();
}
