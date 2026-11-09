-- Agent actions now take effect (docs/specs/agent-staff-platform.md, A12–A14):
-- an approved or auto-approved proposal is carried out once, what it made is
-- recorded, notes appear on the thread, and a human can take a thread over.

-- What carrying the action out made: the draft or outgoing email's id, or the note's.
ALTER TABLE agent_actions ADD COLUMN result_ref TEXT;
-- Why it couldn't be carried out (a loop guard, a paused agent, a send error).
-- Set means it won't be tried again.
ALTER TABLE agent_actions ADD COLUMN exec_error TEXT;
-- Set while it is being carried out, so it runs once even if two requests race.
ALTER TABLE agent_actions ADD COLUMN exec_claimed_at TEXT;

-- Anything approved before actions could run stays recorded but never runs late.
UPDATE agent_actions SET exec_error = 'approved_before_execution'
WHERE status IN ('approved', 'auto_approved') AND executed_at IS NULL;

-- Private notes on a thread: an agent's note for the founder, or an alert when
-- an agent stopped itself. Only the mailbox owner sees them.
CREATE TABLE IF NOT EXISTS thread_notes (
	id TEXT PRIMARY KEY,
	workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
	mailbox_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	thread_id TEXT NOT NULL,
	author_principal_id TEXT REFERENCES principals(id) ON DELETE SET NULL,
	kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'alert')),
	body TEXT NOT NULL,
	action_id TEXT REFERENCES agent_actions(id) ON DELETE SET NULL,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thread_notes_thread ON thread_notes(mailbox_user_id, thread_id, created_at);

-- A human took the thread over: agents stop acting on it until it's handed back (A13).
CREATE TABLE IF NOT EXISTS thread_takeovers (
	mailbox_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	thread_id TEXT NOT NULL,
	by_principal_id TEXT REFERENCES principals(id) ON DELETE SET NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (mailbox_user_id, thread_id)
);
