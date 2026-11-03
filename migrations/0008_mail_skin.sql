-- Per-account UI preferences (today: the mail skin — ledger, desk, notes, classic).
-- Idempotent on purpose: the app also creates this table on first save, so the
-- migration can run before or after that without failing.
CREATE TABLE IF NOT EXISTS user_preferences (
	user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
	mail_skin TEXT,
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
