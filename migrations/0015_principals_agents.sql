-- Agent Staff, Phase 0 (docs/specs/agent-staff-platform.md, A1, A3, A6, A7).
--
-- Humans and agents are both "principals" in a workspace. A deploy has one
-- workspace for now. Existing tables keep scoping by user_id; principals map
-- users into the workspace, so no existing mail behaviour changes.

CREATE TABLE IF NOT EXISTS workspaces (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO workspaces (id, name) VALUES ('default', 'Default');

CREATE TABLE IF NOT EXISTS principals (
	id TEXT PRIMARY KEY,
	workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
	kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
	-- Set for humans only: the sign-in identity behind the principal.
	user_id TEXT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
	display_name TEXT NOT NULL,
	-- Set for agents only: the human who hired it.
	owner_principal_id TEXT REFERENCES principals(id) ON DELETE SET NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	CHECK ((kind = 'human') = (user_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_principals_workspace ON principals(workspace_id, kind);

-- Every existing user becomes a human principal.
INSERT OR IGNORE INTO principals (id, workspace_id, kind, user_id, display_name)
SELECT 'p_' || id, 'default', 'human', id, name FROM users;

-- So does every user created later, whichever code path creates them.
CREATE TRIGGER IF NOT EXISTS users_human_principal AFTER INSERT ON users
BEGIN
	INSERT OR IGNORE INTO principals (id, workspace_id, kind, user_id, display_name)
	VALUES ('p_' || NEW.id, 'default', 'human', NEW.id, NEW.name);
END;

CREATE TABLE IF NOT EXISTS agents (
	principal_id TEXT PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
	status TEXT NOT NULL DEFAULT 'shadow' CHECK (status IN ('shadow', 'active', 'paused')),
	runtime TEXT NOT NULL DEFAULT 'builtin' CHECK (runtime IN ('builtin', 'external')),
	current_version_id TEXT,
	-- Proposals left before shadow mode ends on its own (A8).
	shadow_remaining INTEGER NOT NULL DEFAULT 20,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- An agent's definition (job, capabilities, scope, triggers) is versioned (A3).
CREATE TABLE IF NOT EXISTS agent_versions (
	id TEXT PRIMARY KEY,
	agent_principal_id TEXT NOT NULL REFERENCES agents(principal_id) ON DELETE CASCADE,
	version INTEGER NOT NULL,
	definition_json TEXT NOT NULL,
	created_by_principal_id TEXT REFERENCES principals(id) ON DELETE SET NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	UNIQUE (agent_principal_id, version)
);

-- Every proposal an agent makes, and what the policy engine decided (A6, A7).
CREATE TABLE IF NOT EXISTS agent_actions (
	id TEXT PRIMARY KEY,
	workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
	agent_principal_id TEXT NOT NULL REFERENCES agents(principal_id) ON DELETE CASCADE,
	version_id TEXT REFERENCES agent_versions(id) ON DELETE SET NULL,
	capability TEXT NOT NULL,
	thread_id TEXT,
	payload_json TEXT NOT NULL,
	reason TEXT NOT NULL DEFAULT '',
	-- queued: waiting for a human. auto_approved: allowed to run now.
	-- shadowed: would have run, but the agent is in shadow mode.
	-- rejected: refused by policy. approved / declined: a human decided.
	-- expired: nobody decided in time. executed: the effect happened.
	status TEXT NOT NULL CHECK (status IN (
		'queued', 'auto_approved', 'shadowed', 'rejected',
		'approved', 'declined', 'expired', 'executed'
	)),
	policy_reason TEXT NOT NULL,
	expires_at TEXT,
	decided_by_principal_id TEXT REFERENCES principals(id) ON DELETE SET NULL,
	decision_note TEXT,
	edited INTEGER NOT NULL DEFAULT 0,
	decided_at TEXT,
	executed_at TEXT,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_actions_queue ON agent_actions(workspace_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_actions_usage ON agent_actions(agent_principal_id, capability, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_actions_thread ON agent_actions(thread_id);
