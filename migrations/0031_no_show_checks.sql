-- No-shows (docs/specs/demo-role-end-to-end.md, R13). Ten minutes after a
-- meeting on a page an agent runs, Needs your OK asks the host whether the
-- guest came. "No-show" queues a "sorry we missed you" email offering new
-- times. With no answer in a day, it's taken that they came, and nothing happens.
CREATE TABLE IF NOT EXISTS booking_checks (
	id TEXT PRIMARY KEY,
	booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
	-- The start it asks about: a moved meeting is asked about again.
	for_start TEXT NOT NULL,
	workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
	agent_principal_id TEXT REFERENCES agents(principal_id) ON DELETE SET NULL,
	-- The host: only they see and answer it.
	mailbox_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	-- asked -> showed | no_show | assumed_showed (no answer in time).
	status TEXT NOT NULL DEFAULT 'asked' CHECK (status IN ('asked', 'showed', 'no_show', 'assumed_showed')),
	asked_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	answered_at TEXT,
	answered_by_principal_id TEXT REFERENCES principals(id) ON DELETE SET NULL,
	-- The "sorry we missed you" email: the queued action, or the draft in the host's Drafts.
	sorry_ref TEXT,
	UNIQUE (booking_id, for_start)
);
CREATE INDEX IF NOT EXISTS idx_booking_checks_open ON booking_checks(mailbox_user_id, status, expires_at);
