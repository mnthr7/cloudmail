import type { D1Database } from '@cloudflare/workers-types';
import { parseEmailAddress } from '#lib/email-address.ts';
import { isMailCategory, type MailCategory } from '#lib/organizing/categories.ts';
import { filterMatches, type FilterRule } from '#lib/organizing/filters.ts';
import type { EmailProvider } from '#lib/server/email-provider.ts';
import {
	applyFilterActions,
	forwardFiledMail,
	type FilterActionRule
} from '#lib/server/organize-inbound.ts';

/** D1 rejects a statement with more than this many bound parameters. */
const D1_PARAM_CAP = 100;

const FORWARD_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type FilterWriteCode = 'condition' | 'action' | 'forward' | 'category' | 'label';

/** A rejected create or edit. Routes map `code` to HTTP 400 `{ error: code }`. */
export class FilterWriteError extends Error {
	readonly status = 400;

	constructor(readonly code: FilterWriteCode) {
		super(code);
		this.name = 'FilterWriteError';
	}
}

/** No row for this user. Routes map this to HTTP 404. */
export class FilterNotFoundError extends Error {
	readonly status = 404;

	constructor() {
		super('Not found');
		this.name = 'FilterNotFoundError';
	}
}

export type FilterRecord = {
	id: string;
	position: number;
	enabled: boolean;
	matchFrom: string | null;
	matchTo: string | null;
	matchSubject: string | null;
	matchWords: string | null;
	matchHasAttachment: boolean;
	actionLabelId: string | null;
	actionSkipInbox: boolean;
	actionStar: boolean;
	actionImportant: boolean;
	actionMarkRead: boolean;
	actionTrash: boolean;
	actionCategory: MailCategory | null;
	actionForwardTo: string | null;
};

/** Fields a create or edit may set. Omitted text becomes blank. Omitted flags stay off on create. */
export type FilterDraft = {
	enabled?: boolean;
	matchFrom?: string | null;
	matchTo?: string | null;
	matchSubject?: string | null;
	matchWords?: string | null;
	matchHasAttachment?: boolean;
	actionLabelId?: string | null;
	actionSkipInbox?: boolean;
	actionStar?: boolean;
	actionImportant?: boolean;
	actionMarkRead?: boolean;
	actionTrash?: boolean;
	actionCategory?: string | null;
	actionForwardTo?: string | null;
};

export type BlockedSender = {
	address: string;
	createdAt: string;
};

type FilterRow = {
	id: string;
	position: number;
	enabled: number;
	match_from: string | null;
	match_to: string | null;
	match_subject: string | null;
	match_words: string | null;
	match_has_attachment: number;
	action_label_id: string | null;
	action_skip_inbox: number;
	action_star: number;
	action_important: number;
	action_mark_read: number;
	action_trash: number;
	action_category: string | null;
	action_forward_to: string | null;
};

type InboundRow = {
	id: string;
	thread_id: string | null;
	from_addr: string;
	to_addr: string;
	subject: string;
	body_text: string | null;
	created_at: string | null;
};

const FILTER_COLUMNS = `id, position, enabled, match_from, match_to, match_subject, match_words,
	match_has_attachment, action_label_id, action_skip_inbox, action_star, action_important,
	action_mark_read, action_trash, action_category, action_forward_to`;

/** Every filter the user owns, in the order new mail runs them. */
export async function listFilters(db: D1Database, userId: string): Promise<FilterRecord[]> {
	const { results } = await db
		.prepare(
			`SELECT ${FILTER_COLUMNS}
			 FROM filters
			 WHERE user_id = ?
			 ORDER BY position ASC, id ASC`
		)
		.bind(userId)
		.all<FilterRow>();

	return (results ?? []).map(toRecord);
}

/**
 * Inserts one filter. Position is `MAX(position) + 1` for this user.
 * At least one condition and one action are required.
 */
export async function createFilter(
	db: D1Database,
	userId: string,
	draft: FilterDraft
): Promise<FilterRecord> {
	const filter = await normalize(db, userId, draft);
	const position = await nextPosition(db, userId);
	const id = crypto.randomUUID();

	try {
		await db
			.prepare(
				`INSERT INTO filters (
					id, user_id, position, enabled,
					match_from, match_to, match_subject, match_words, match_has_attachment,
					action_label_id, action_skip_inbox, action_star, action_important,
					action_mark_read, action_trash, action_category, action_forward_to
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				id,
				userId,
				position,
				filter.enabled ? 1 : 0,
				filter.matchFrom,
				filter.matchTo,
				filter.matchSubject,
				filter.matchWords,
				filter.matchHasAttachment ? 1 : 0,
				filter.actionLabelId,
				filter.actionSkipInbox ? 1 : 0,
				filter.actionStar ? 1 : 0,
				filter.actionImportant ? 1 : 0,
				filter.actionMarkRead ? 1 : 0,
				filter.actionTrash ? 1 : 0,
				filter.actionCategory,
				filter.actionForwardTo
			)
			.run();
	} catch (error) {
		throw mapWriteError(error);
	}

	const saved = await readFilter(db, userId, id);
	if (!saved) throw new FilterNotFoundError();
	return saved;
}

/** Edits one filter. Omitted fields stay as they are. The saved row is validated again. */
export async function updateFilter(
	db: D1Database,
	userId: string,
	id: string,
	patch: FilterDraft
): Promise<FilterRecord> {
	const current = await readFilter(db, userId, id);
	if (!current) throw new FilterNotFoundError();

	const filter = await normalize(db, userId, {
		enabled: patch.enabled ?? current.enabled,
		matchFrom: patch.matchFrom === undefined ? current.matchFrom : patch.matchFrom,
		matchTo: patch.matchTo === undefined ? current.matchTo : patch.matchTo,
		matchSubject: patch.matchSubject === undefined ? current.matchSubject : patch.matchSubject,
		matchWords: patch.matchWords === undefined ? current.matchWords : patch.matchWords,
		matchHasAttachment:
			patch.matchHasAttachment === undefined ? current.matchHasAttachment : patch.matchHasAttachment,
		actionLabelId: patch.actionLabelId === undefined ? current.actionLabelId : patch.actionLabelId,
		actionSkipInbox: patch.actionSkipInbox === undefined ? current.actionSkipInbox : patch.actionSkipInbox,
		actionStar: patch.actionStar === undefined ? current.actionStar : patch.actionStar,
		actionImportant:
			patch.actionImportant === undefined ? current.actionImportant : patch.actionImportant,
		actionMarkRead: patch.actionMarkRead === undefined ? current.actionMarkRead : patch.actionMarkRead,
		actionTrash: patch.actionTrash === undefined ? current.actionTrash : patch.actionTrash,
		actionCategory: patch.actionCategory === undefined ? current.actionCategory : patch.actionCategory,
		actionForwardTo:
			patch.actionForwardTo === undefined ? current.actionForwardTo : patch.actionForwardTo
	});

	try {
		await db
			.prepare(
				`UPDATE filters SET
					enabled = ?,
					match_from = ?, match_to = ?, match_subject = ?, match_words = ?,
					match_has_attachment = ?,
					action_label_id = ?, action_skip_inbox = ?, action_star = ?, action_important = ?,
					action_mark_read = ?, action_trash = ?, action_category = ?, action_forward_to = ?
				 WHERE id = ? AND user_id = ?`
			)
			.bind(
				filter.enabled ? 1 : 0,
				filter.matchFrom,
				filter.matchTo,
				filter.matchSubject,
				filter.matchWords,
				filter.matchHasAttachment ? 1 : 0,
				filter.actionLabelId,
				filter.actionSkipInbox ? 1 : 0,
				filter.actionStar ? 1 : 0,
				filter.actionImportant ? 1 : 0,
				filter.actionMarkRead ? 1 : 0,
				filter.actionTrash ? 1 : 0,
				filter.actionCategory,
				filter.actionForwardTo,
				id,
				userId
			)
			.run();
	} catch (error) {
		throw mapWriteError(error);
	}

	const saved = await readFilter(db, userId, id);
	if (!saved) throw new FilterNotFoundError();
	return saved;
}

/** Deletes one filter. Mail it already changed stays as it is. */
export async function deleteFilter(db: D1Database, userId: string, id: string): Promise<void> {
	const result = await db
		.prepare('DELETE FROM filters WHERE id = ? AND user_id = ?')
		.bind(id, userId)
		.run();
	if (!result.meta.changes) throw new FilterNotFoundError();
}

export type ApplyFilterOptions = {
	dryRun?: boolean;
	/** Used when the filter forwards. A missing provider counts as a failed forward. */
	provider?: EmailProvider;
	resolveProvider?: () => EmailProvider | undefined;
};

/**
 * Counts matching conversations, or runs the filter on each one.
 * `{ dryRun: true }` returns `{ matched }` and writes nothing.
 * Otherwise returns `{ changed, forwardFailed }`. Both counts are conversations,
 * except `forwardFailed`, which is sends that did not go out.
 * Running this again sends another copy of each forward.
 */
export async function applySavedFilter(
	db: D1Database,
	userId: string,
	filterId: string,
	options: ApplyFilterOptions & { dryRun: true }
): Promise<{ matched: number }>;
export async function applySavedFilter(
	db: D1Database,
	userId: string,
	filterId: string,
	options?: ApplyFilterOptions
): Promise<{ changed: number; forwardFailed: number }>;
export async function applySavedFilter(
	db: D1Database,
	userId: string,
	filterId: string,
	options?: ApplyFilterOptions
): Promise<{ matched: number } | { changed: number; forwardFailed: number }> {
	const filter = await readFilter(db, userId, filterId);
	if (!filter) throw new FilterNotFoundError();

	const matches = await matchingConversations(db, userId, filter);
	if (options?.dryRun) return { matched: matches.size };

	if (filter.actionLabelId) {
		const owned = await db
			.prepare('SELECT id FROM labels WHERE id = ? AND user_id = ?')
			.bind(filter.actionLabelId, userId)
			.first<{ id: string }>();
		if (!owned) throw new FilterWriteError('label');
	}

	const target = filter.actionForwardTo?.trim() ?? '';
	const provider = target ? (options?.provider ?? options?.resolveProvider?.()) : undefined;
	let forwardFailed = 0;

	for (const row of matches.values()) {
		await applyFilterActions(db, userId, row.id, toActionRule(filter));
		if (!target) continue;
		forwardFailed += await forwardFiledMail(
			db,
			userId,
			row.id,
			{ subject: row.subject, body_text: row.body_text },
			[target],
			provider
		);
	}

	return { changed: matches.size, forwardFailed };
}

/** Blocked mailbox addresses, oldest first. */
export async function listBlockedSenders(db: D1Database, userId: string): Promise<BlockedSender[]> {
	const { results } = await db
		.prepare(
			`SELECT address, created_at
			 FROM blocked_senders
			 WHERE user_id = ?
			 ORDER BY datetime(created_at) ASC, address ASC`
		)
		.bind(userId)
		.all<{ address: string; created_at: string }>();

	return (results ?? []).map((row) => ({ address: row.address, createdAt: row.created_at }));
}

/**
 * Removes one blocked address. Returns false when the value is not a mailbox address.
 * A missing row is still a successful removal.
 */
export async function removeBlockedSender(
	db: D1Database,
	userId: string,
	address: string
): Promise<boolean> {
	const bare = bareMailbox(address);
	if (!bare) return false;

	await db
		.prepare('DELETE FROM blocked_senders WHERE user_id = ? AND address = ?')
		.bind(userId, bare)
		.run();
	return true;
}

async function readFilter(
	db: D1Database,
	userId: string,
	id: string
): Promise<FilterRecord | null> {
	const row = await db
		.prepare(
			`SELECT ${FILTER_COLUMNS}
			 FROM filters
			 WHERE id = ? AND user_id = ?`
		)
		.bind(id, userId)
		.first<FilterRow>();
	return row ? toRecord(row) : null;
}

async function nextPosition(db: D1Database, userId: string): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COALESCE(MAX(position), 0) + 1 AS next_position
			 FROM filters WHERE user_id = ?`
		)
		.bind(userId)
		.first<{ next_position: number }>();
	return Number(row?.next_position ?? 1);
}

/**
 * Inbound messages whose conversation matches, one row per conversation.
 * The kept row is the newest matching inbound message, which is the one a forward copies.
 */
async function matchingConversations(
	db: D1Database,
	userId: string,
	filter: FilterRecord
): Promise<Map<string, InboundRow>> {
	const { results } = await db
		.prepare(
			`SELECT id, thread_id, from_addr, to_addr, subject, body_text, created_at
			 FROM emails
			 WHERE user_id = ? AND direction = 'inbound'
			 ORDER BY datetime(created_at) ASC, id ASC`
		)
		.bind(userId)
		.all<InboundRow>();

	const rows = results ?? [];
	const attachments = filter.matchHasAttachment
		? await attachmentEmailIds(db, rows.map((row) => row.id))
		: new Set<string>();
	const rule = toMatchRule(filter);
	const matches = new Map<string, InboundRow>();

	for (const row of rows) {
		const matched = filterMatches(rule, {
			from: row.from_addr,
			to: row.to_addr,
			subject: row.subject,
			bodyText: row.body_text ?? '',
			hasAttachment: attachments.has(row.id)
		});
		if (!matched) continue;

		const key = row.thread_id ?? row.id;
		const current = matches.get(key);
		if (!current || isNewer(row, current)) matches.set(key, row);
	}

	return matches;
}

/**
 * Which of these messages have a stored attachment.
 * The id list is bound once per statement. A long list is split so the
 * statement stays within D1's parameter cap.
 */
async function attachmentEmailIds(db: D1Database, emailIds: string[]): Promise<Set<string>> {
	const found = new Set<string>();

	for (const chunk of paramChunks(emailIds, 0)) {
		const marks = chunk.map(() => '?').join(', ');
		const { results } = await db
			.prepare(
				`SELECT DISTINCT email_id AS email_id
				 FROM email_attachments
				 WHERE email_id IN (${marks})`
			)
			.bind(...chunk)
			.all<{ email_id: string }>();

		for (const row of results ?? []) found.add(row.email_id);
	}

	return found;
}

function paramChunks<T>(values: T[], boundElsewhere: number): T[][] {
	const size = D1_PARAM_CAP - boundElsewhere;
	if (size < 1) throw new Error('Not enough room for bound parameters');

	const chunks: T[][] = [];
	for (let index = 0; index < values.length; index += size) {
		chunks.push(values.slice(index, index + size));
	}
	return chunks;
}

function isNewer(candidate: InboundRow, current: InboundRow): boolean {
	const left = candidate.created_at ?? '';
	const right = current.created_at ?? '';
	if (left !== right) return left > right;
	return candidate.id > current.id;
}

async function normalize(
	db: D1Database,
	userId: string,
	draft: FilterDraft
): Promise<Omit<FilterRecord, 'id' | 'position'>> {
	const matchFrom = text(draft.matchFrom);
	const matchTo = text(draft.matchTo);
	const matchSubject = text(draft.matchSubject);
	const matchWords = text(draft.matchWords);
	const matchHasAttachment = draft.matchHasAttachment === true;
	const actionForwardTo = text(draft.actionForwardTo);
	const actionLabelId = text(draft.actionLabelId);
	const actionCategory = category(draft.actionCategory);

	if (actionForwardTo && !FORWARD_ADDRESS.test(actionForwardTo)) {
		throw new FilterWriteError('forward');
	}
	if (actionLabelId && !(await labelOwned(db, userId, actionLabelId))) {
		throw new FilterWriteError('label');
	}

	const hasCondition = Boolean(matchFrom || matchTo || matchSubject || matchWords || matchHasAttachment);
	if (!hasCondition) throw new FilterWriteError('condition');

	const hasAction = Boolean(
		actionLabelId ||
			draft.actionSkipInbox ||
			draft.actionStar ||
			draft.actionImportant ||
			draft.actionMarkRead ||
			draft.actionTrash ||
			actionCategory ||
			actionForwardTo
	);
	if (!hasAction) throw new FilterWriteError('action');

	return {
		enabled: draft.enabled !== false,
		matchFrom,
		matchTo,
		matchSubject,
		matchWords,
		matchHasAttachment,
		actionLabelId,
		actionSkipInbox: draft.actionSkipInbox === true,
		actionStar: draft.actionStar === true,
		actionImportant: draft.actionImportant === true,
		actionMarkRead: draft.actionMarkRead === true,
		actionTrash: draft.actionTrash === true,
		actionCategory,
		actionForwardTo
	};
}

function category(value: string | null | undefined): MailCategory | null {
	const trimmed = text(value);
	if (!trimmed) return null;
	if (!isMailCategory(trimmed)) throw new FilterWriteError('category');
	return trimmed;
}

async function labelOwned(db: D1Database, userId: string, labelId: string): Promise<boolean> {
	const row = await db
		.prepare('SELECT id FROM labels WHERE id = ? AND user_id = ?')
		.bind(labelId, userId)
		.first<{ id: string }>();
	return Boolean(row);
}

function text(value: string | null | undefined): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}

function bareMailbox(value: string): string | null {
	const bare = parseEmailAddress(value);
	const at = bare.indexOf('@');
	if (at <= 0 || at !== bare.lastIndexOf('@') || at === bare.length - 1) return null;
	return bare;
}

function toMatchRule(filter: FilterRecord): FilterRule {
	return {
		matchFrom: filter.matchFrom,
		matchTo: filter.matchTo,
		matchSubject: filter.matchSubject,
		matchWords: filter.matchWords,
		matchHasAttachment: filter.matchHasAttachment
	};
}

function toActionRule(filter: FilterRecord): FilterActionRule {
	return {
		actionLabelId: filter.actionLabelId,
		actionSkipInbox: filter.actionSkipInbox,
		actionStar: filter.actionStar,
		actionImportant: filter.actionImportant,
		actionMarkRead: filter.actionMarkRead,
		actionTrash: filter.actionTrash,
		actionCategory: filter.actionCategory,
		actionForwardTo: filter.actionForwardTo
	};
}

function toRecord(row: FilterRow): FilterRecord {
	return {
		id: row.id,
		position: Number(row.position),
		enabled: Number(row.enabled) === 1,
		matchFrom: row.match_from,
		matchTo: row.match_to,
		matchSubject: row.match_subject,
		matchWords: row.match_words,
		matchHasAttachment: Number(row.match_has_attachment) === 1,
		actionLabelId: row.action_label_id,
		actionSkipInbox: Number(row.action_skip_inbox) === 1,
		actionStar: Number(row.action_star) === 1,
		actionImportant: Number(row.action_important) === 1,
		actionMarkRead: Number(row.action_mark_read) === 1,
		actionTrash: Number(row.action_trash) === 1,
		actionCategory: isMailCategory(row.action_category) ? row.action_category : null,
		actionForwardTo: row.action_forward_to
	};
}

function mapWriteError(error: unknown): unknown {
	const message = error instanceof Error ? error.message : String(error);
	if (message.includes('FOREIGN KEY')) return new FilterWriteError('label');
	return error;
}

const TEXT_KEYS = [
	'matchFrom',
	'matchTo',
	'matchSubject',
	'matchWords',
	'actionLabelId',
	'actionForwardTo'
] as const;

const FLAG_KEYS = [
	'matchHasAttachment',
	'actionSkipInbox',
	'actionStar',
	'actionImportant',
	'actionMarkRead',
	'actionTrash'
] as const;

/**
 * Reads a filter body. Create fills omitted fields. Patch keeps only the keys that were sent.
 * A wrong JSON type is rejected so the store never sees a number where a string belongs.
 */
export function parseFilterBody(
	body: Record<string, unknown>,
	mode: 'create' | 'patch'
): FilterDraft | null {
	const draft: FilterDraft = {};
	const create = mode === 'create';

	if (Object.prototype.hasOwnProperty.call(body, 'enabled')) {
		if (typeof body.enabled !== 'boolean') return null;
		draft.enabled = body.enabled;
	} else if (create) {
		draft.enabled = true;
	}

	for (const key of TEXT_KEYS) {
		if (!Object.prototype.hasOwnProperty.call(body, key)) {
			if (create) draft[key] = null;
			continue;
		}
		const value = body[key];
		if (value === null) {
			draft[key] = null;
			continue;
		}
		if (typeof value !== 'string') return null;
		draft[key] = value;
	}

	for (const key of FLAG_KEYS) {
		if (!Object.prototype.hasOwnProperty.call(body, key)) {
			if (create) draft[key] = false;
			continue;
		}
		if (typeof body[key] !== 'boolean') return null;
		draft[key] = body[key] as boolean;
	}

	if (Object.prototype.hasOwnProperty.call(body, 'actionCategory')) {
		const value = body.actionCategory;
		if (value === null) draft.actionCategory = null;
		else if (typeof value !== 'string') return null;
		else draft.actionCategory = value;
	} else if (create) {
		draft.actionCategory = null;
	}

	return draft;
}
