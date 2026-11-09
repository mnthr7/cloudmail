-- Reply suggestions: when mail arrives, an agent writes two or three replies
-- the mailbox owner can send with one click or edit first. The owner sends
-- them as themselves, so they don't go through the approval queue. Each set
-- records what the owner did with it, which is how an agent's suggestions are
-- judged.

CREATE TABLE IF NOT EXISTS reply_suggestions (
	id TEXT PRIMARY KEY,
	workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
	agent_principal_id TEXT NOT NULL REFERENCES agents(principal_id) ON DELETE CASCADE,
	run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
	-- Only this person sees the suggestions: it's their copy of the thread.
	mailbox_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	-- The message the replies answer, and its conversation.
	email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
	thread_id TEXT NOT NULL,
	-- What the agent understood the sender wants, in a line.
	intent TEXT NOT NULL,
	-- 0 when the agent judged no reply is needed (a receipt, a newsletter).
	reply_needed INTEGER NOT NULL DEFAULT 1,
	-- [{ "label": "...", "body": "..." }], at most three.
	options_json TEXT NOT NULL,
	model TEXT,
	created_at TEXT NOT NULL,
	-- open -> sent | dismissed | replaced (a newer set for the same thread).
	status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'sent', 'dismissed', 'replaced')),
	-- Which option was sent, and how much of it the owner changed: 0 as written, 1 rewritten.
	chosen_index INTEGER,
	edit_ratio REAL,
	sent_email_id TEXT REFERENCES emails(id) ON DELETE SET NULL,
	decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reply_suggestions_thread ON reply_suggestions(mailbox_user_id, thread_id, status);
CREATE INDEX IF NOT EXISTS idx_reply_suggestions_agent ON reply_suggestions(agent_principal_id, created_at);
