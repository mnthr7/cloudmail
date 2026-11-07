-- Agent runs (docs/specs/agent-staff-platform.md, §8.1 and §8.2): one row each
-- time something wakes an agent up. The every-minute cron claims pending runs,
-- calls the model, and records every proposal it makes through the policy
-- engine. A run never carries anything out by itself.

CREATE TABLE IF NOT EXISTS agent_runs (
	id TEXT PRIMARY KEY,
	workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
	agent_principal_id TEXT NOT NULL REFERENCES agents(principal_id) ON DELETE CASCADE,
	-- The definition version the run used, set when it starts.
	version_id TEXT REFERENCES agent_versions(id) ON DELETE SET NULL,
	-- Whose mailbox the thread is in. The agent reads only that copy of it.
	mailbox_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	-- The message that started the run. The agent reads its whole conversation.
	email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
	-- mail: arrived at an address the agent watches. ask: a human asked it on a thread.
	trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('mail', 'ask')),
	-- The email id for mail, a fresh id for each ask. Makes each trigger run once.
	trigger_ref TEXT NOT NULL,
	-- What the human asked for (ask only). An instruction, unlike the mail itself.
	request TEXT,
	requested_by_principal_id TEXT REFERENCES principals(id) ON DELETE SET NULL,
	-- pending -> running -> done | failed | skipped. A run that stalls in
	-- running is picked up again, at most three attempts in all.
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed', 'skipped')),
	-- Why it was skipped or failed, or how the model finished.
	outcome TEXT,
	-- What the agent said it did, for the activity list.
	summary TEXT,
	attempts INTEGER NOT NULL DEFAULT 0,
	model TEXT,
	input_tokens INTEGER NOT NULL DEFAULT 0,
	output_tokens INTEGER NOT NULL DEFAULT 0,
	-- Cost in millionths of a dollar, so a month's spend is a plain SUM.
	cost_micros INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	started_at TEXT,
	finished_at TEXT,
	UNIQUE (agent_principal_id, trigger_kind, trigger_ref)
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_due ON agent_runs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent_principal_id, created_at);

-- Which run proposed an action, and the founder's thumbs up or down on it (A8).
ALTER TABLE agent_actions ADD COLUMN run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL;
ALTER TABLE agent_actions ADD COLUMN feedback TEXT CHECK (feedback IN ('up', 'down'));
CREATE INDEX IF NOT EXISTS idx_agent_actions_run ON agent_actions(run_id);
