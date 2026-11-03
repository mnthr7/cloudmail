ALTER TABLE emails ADD COLUMN in_inbox INTEGER NOT NULL DEFAULT 1;
ALTER TABLE emails ADD COLUMN category TEXT NOT NULL DEFAULT 'primary';
ALTER TABLE emails ADD COLUMN is_important INTEGER NOT NULL DEFAULT 0;
ALTER TABLE emails ADD COLUMN snoozed_until TEXT;
ALTER TABLE emails ADD COLUMN is_muted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE emails ADD COLUMN list_unsubscribe TEXT;
ALTER TABLE emails ADD COLUMN list_unsubscribe_post TEXT;

CREATE INDEX idx_emails_inbox ON emails(user_id, in_inbox, category);
CREATE INDEX idx_emails_snooze ON emails(user_id, snoozed_until);

CREATE TABLE labels (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	parent_id TEXT REFERENCES labels(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	color TEXT NOT NULL DEFAULT 'slate',
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_labels_sibling ON labels(user_id, ifnull(parent_id, ''), name COLLATE NOCASE);

CREATE TABLE thread_labels (
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	thread_id TEXT NOT NULL,
	label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
	PRIMARY KEY (user_id, thread_id, label_id)
);

CREATE TABLE sender_categories (
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	from_addr TEXT NOT NULL COLLATE NOCASE,
	category TEXT NOT NULL,
	PRIMARY KEY (user_id, from_addr)
);

CREATE TABLE filters (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	position INTEGER NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1,
	match_from TEXT,
	match_to TEXT,
	match_subject TEXT,
	match_words TEXT,
	match_has_attachment INTEGER NOT NULL DEFAULT 0,
	action_label_id TEXT REFERENCES labels(id) ON DELETE SET NULL,
	action_skip_inbox INTEGER NOT NULL DEFAULT 0,
	action_star INTEGER NOT NULL DEFAULT 0,
	action_important INTEGER NOT NULL DEFAULT 0,
	action_mark_read INTEGER NOT NULL DEFAULT 0,
	action_trash INTEGER NOT NULL DEFAULT 0,
	action_category TEXT,
	action_forward_to TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE blocked_senders (
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	address TEXT NOT NULL COLLATE NOCASE,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	PRIMARY KEY (user_id, address)
);

ALTER TABLE user_preferences ADD COLUMN priority_inbox INTEGER NOT NULL DEFAULT 0;
