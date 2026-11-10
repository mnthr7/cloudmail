-- Agent memory and Sam, the generalist (docs/specs/agent-staff-platform.md, A9, A15).

-- Facts an agent always knows ("Globex pays on the 15th"). Everything here is
-- shown in full on the agent's page and can be edited there. A fact gets in
-- only from a human: typed by hand, "@agent remember: ...", or an agent's
-- proposal that a human approved.
CREATE TABLE IF NOT EXISTS agent_memory (
	id TEXT PRIMARY KEY,
	agent_principal_id TEXT NOT NULL REFERENCES agents(principal_id) ON DELETE CASCADE,
	fact TEXT NOT NULL,
	-- founder: a human wrote it. agent: the agent proposed it and a human approved.
	source TEXT NOT NULL CHECK (source IN ('founder', 'agent')),
	added_by_principal_id TEXT REFERENCES principals(id) ON DELETE SET NULL,
	action_id TEXT REFERENCES agent_actions(id) ON DELETE SET NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_memory_agent ON agent_memory(agent_principal_id, created_at);

-- What kind of task a generalist's run was ("chase overdue invoice"), so
-- repeated kinds can become a specialist.
ALTER TABLE agent_runs ADD COLUMN task_label TEXT;
CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(agent_principal_id, task_label, created_at);
