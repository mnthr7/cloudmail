import type { D1Database } from '@cloudflare/workers-types';
import { LABEL_COLORS, labelEditError, type LabelColor, type LabelDraft } from '$lib/organizing/labels';

export type LabelRecord = {
	id: string;
	parentId: string | null;
	name: string;
	color: LabelColor;
	unread: number;
};

export type LabelWriteCode = 'duplicate' | 'cycle' | 'depth' | 'color' | 'parent';

/** A rejected create or edit. Routes map `code` to HTTP 400 `{ error: code }`. */
export class LabelWriteError extends Error {
	readonly status = 400;

	constructor(readonly code: LabelWriteCode) {
		super(code);
		this.name = 'LabelWriteError';
	}
}

/** No row for this user. Routes map this to HTTP 404. */
export class LabelNotFoundError extends Error {
	readonly status = 404;

	constructor() {
		super('Not found');
		this.name = 'LabelNotFoundError';
	}
}

type StoredLabel = LabelDraft & { color: string };

type LabelRow = {
	id: string;
	parent_id: string | null;
	name: string;
	color: string;
	unread: number | null;
};

/**
 * Every label the user owns.
 * Unread counts conversations carrying this exact label that have a message
 * which is unread, not spam, and not trash. A child label does not add to
 * its parent. The user id is the only bound parameter.
 */
export async function listLabels(db: D1Database, userId: string): Promise<LabelRecord[]> {
	const { results } = await db
		.prepare(
			`SELECT l.id, l.parent_id, l.name, l.color,
			        (
			          SELECT COUNT(DISTINCT tl.thread_id)
			          FROM thread_labels tl
			          WHERE tl.user_id = l.user_id
			            AND tl.label_id = l.id
			            AND EXISTS (
			              SELECT 1 FROM emails e
			              WHERE e.user_id = tl.user_id
			                AND COALESCE(e.thread_id, e.id) = tl.thread_id
			                AND e.is_read = 0
			                AND e.is_spam = 0
			                AND e.deleted_at IS NULL
			            )
			        ) AS unread
			 FROM labels l
			 WHERE l.user_id = ?
			 ORDER BY datetime(l.created_at) ASC, l.id ASC`
		)
		.bind(userId)
		.all<LabelRow>();

	return (results ?? []).map(toRecord);
}

export async function createLabel(
	db: D1Database,
	userId: string,
	input: { name: string; parentId: string | null; color: string }
): Promise<LabelRecord> {
	const color = requireColor(input.color);
	const name = input.name.trim();
	const existing = await loadStored(db, userId);
	requireParent(existing, input.parentId);
	const id = crypto.randomUUID();
	rejectEdit(existing, { id, parentId: input.parentId, name });
	await insertLabel(db, userId, { id, parentId: input.parentId, name, color });
	return (await readLabel(db, userId, id)) ?? { id, parentId: input.parentId, name, color, unread: 0 };
}

export async function updateLabel(
	db: D1Database,
	userId: string,
	id: string,
	patch: { name?: string; parentId?: string | null; color?: string }
): Promise<LabelRecord> {
	const existing = await loadStored(db, userId);
	const current = existing.find((label) => label.id === id);
	if (!current) throw new LabelNotFoundError();

	const name = (patch.name ?? current.name).trim();
	const parentId = patch.parentId === undefined ? current.parentId : patch.parentId;
	const color = requireColor(patch.color === undefined ? current.color : patch.color);
	requireParent(existing, parentId);
	rejectEdit(existing, { id, parentId, name });

	try {
		await db
			.prepare(
				`UPDATE labels SET name = ?, parent_id = ?, color = ?
				 WHERE id = ? AND user_id = ?`
			)
			.bind(name, parentId, color, id, userId)
			.run();
	} catch (error) {
		throw mapWriteError(error);
	}

	const saved = await readLabel(db, userId, id);
	if (!saved) throw new LabelNotFoundError();
	return saved;
}

/**
 * Deletes one label row. `parent_id` and `thread_labels.label_id` use
 * ON DELETE CASCADE, so sublabels and memberships go with it. Messages stay.
 */
export async function deleteLabel(db: D1Database, userId: string, id: string): Promise<void> {
	const result = await db
		.prepare('DELETE FROM labels WHERE id = ? AND user_id = ?')
		.bind(id, userId)
		.run();
	if (!result.meta.changes) throw new LabelNotFoundError();
}

function requireColor(color: string): LabelColor {
	if ((LABEL_COLORS as readonly string[]).includes(color)) return color as LabelColor;
	throw new LabelWriteError('color');
}

/** The parent must be one of this user's labels. Cycle and depth are separate. */
function requireParent(existing: StoredLabel[], parentId: string | null): void {
	if (parentId === null) return;
	if (!existing.some((label) => label.id === parentId)) throw new LabelWriteError('parent');
}

function rejectEdit(existing: LabelDraft[], draft: LabelDraft): void {
	const error = labelEditError(existing, draft);
	if (error) throw new LabelWriteError(error);
}

async function insertLabel(
	db: D1Database,
	userId: string,
	label: { id: string; parentId: string | null; name: string; color: LabelColor }
): Promise<void> {
	try {
		await db
			.prepare(
				`INSERT INTO labels (id, user_id, parent_id, name, color)
				 VALUES (?, ?, ?, ?, ?)`
			)
			.bind(label.id, userId, label.parentId, label.name, label.color)
			.run();
	} catch (error) {
		throw mapWriteError(error);
	}
}

function mapWriteError(error: unknown): unknown {
	const message = error instanceof Error ? error.message : String(error);
	if (message.includes('UNIQUE')) return new LabelWriteError('duplicate');
	if (message.includes('FOREIGN KEY')) return new LabelWriteError('parent');
	return error;
}

async function loadStored(db: D1Database, userId: string): Promise<StoredLabel[]> {
	const { results } = await db
		.prepare('SELECT id, parent_id, name, color FROM labels WHERE user_id = ?')
		.bind(userId)
		.all<{ id: string; parent_id: string | null; name: string; color: string }>();

	return (results ?? []).map((row) => ({
		id: row.id,
		parentId: row.parent_id,
		name: row.name,
		color: row.color
	}));
}

async function readLabel(db: D1Database, userId: string, id: string): Promise<LabelRecord | null> {
	const labels = await listLabels(db, userId);
	return labels.find((label) => label.id === id) ?? null;
}

function toRecord(row: LabelRow): LabelRecord {
	return {
		id: row.id,
		parentId: row.parent_id,
		name: row.name,
		color: row.color as LabelColor,
		unread: Number(row.unread ?? 0)
	};
}
