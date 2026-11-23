-- External agents (docs/specs/external-agents.md, E1): agents that think
-- somewhere else (Claude, a custom bot) and work in CloudMail over MCP. They
-- are ordinary agent principals (runtime = 'external'); these tables hold how
-- they connect, what they called, what they need to hear about, and timers.

-- Why CloudMail paused an agent on its own (too many refusals, webhooks
-- failing), shown on the Staff page. Cleared when someone resumes it.
ALTER TABLE agents ADD COLUMN paused_reason TEXT;

-- One row per OAuth grant. Revoking flips status, and every MCP request checks
-- it, so a revoked agent stops at once even while its access token is unexpired.
CREATE TABLE IF NOT EXISTS agent_connections (
	id TEXT PRIMARY KEY,
	agent_principal_id TEXT NOT NULL REFERENCES agents(principal_id) ON DELETE CASCADE,
	kind TEXT NOT NULL DEFAULT 'mcp' CHECK (kind IN ('mcp')),
	client_name TEXT NOT NULL,
	client_id TEXT NOT NULL,
	grant_ref TEXT,
	mailbox_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	webhook_url TEXT,
	-- Sealed with secret-box (context 'agent-webhook:<connection id>').
	webhook_secret_enc TEXT,
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
	last_seen_at TEXT,
	revoked_at TEXT,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_connections_agent ON agent_connections(agent_principal_id);

-- Every tool call, allowed or not (X6). Arguments are kept hashed plus a
-- redacted copy (bodies cut short) so the founder can see what was asked.
CREATE TABLE IF NOT EXISTS tool_call_audit (
	id TEXT PRIMARY KEY,
	agent_principal_id TEXT NOT NULL REFERENCES agents(principal_id) ON DELETE CASCADE,
	connection_id TEXT REFERENCES agent_connections(id) ON DELETE SET NULL,
	tool TEXT NOT NULL,
	args_hash TEXT NOT NULL,
	args_redacted_json TEXT NOT NULL,
	-- read | executed | queued | shadowed | rejected | error | rate_limited | refused
	decision TEXT NOT NULL,
	reason TEXT,
	action_id TEXT,
	latency_ms INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_call_audit_agent_time ON tool_call_audit(agent_principal_id, created_at);

-- What an external agent needs to hear about (X4). IDs only, never bodies:
-- the agent reads content back through get_thread, which re-checks scope.
-- check_new_mail pages through seq; webhooks deliver the same rows.
CREATE TABLE IF NOT EXISTS agent_events (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	agent_principal_id TEXT NOT NULL REFERENCES agents(principal_id) ON DELETE CASCADE,
	type TEXT NOT NULL CHECK (type IN ('message.received', 'action.decided', 'mention.created', 'timer.fired')),
	thread_id TEXT,
	email_id TEXT,
	action_id TEXT,
	timer_id TEXT,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_events_agent_seq ON agent_events(agent_principal_id, seq);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
	id TEXT PRIMARY KEY,
	connection_id TEXT NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
	event_seq INTEGER NOT NULL REFERENCES agent_events(seq) ON DELETE CASCADE,
	attempt INTEGER NOT NULL DEFAULT 0,
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead')),
	status_code INTEGER,
	last_error TEXT,
	next_retry_at TEXT NOT NULL,
	claimed_at TEXT,
	delivered_at TEXT,
	created_at TEXT NOT NULL,
	UNIQUE (connection_id, event_seq)
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due ON webhook_deliveries(status, next_retry_at);

-- "Come back to this thread at …" (set_timer). Fired by the cron.
CREATE TABLE IF NOT EXISTS agent_timers (
	id TEXT PRIMARY KEY,
	agent_principal_id TEXT NOT NULL REFERENCES agents(principal_id) ON DELETE CASCADE,
	mailbox_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	thread_id TEXT NOT NULL,
	fire_at TEXT NOT NULL,
	reason TEXT NOT NULL,
	-- Cancel instead of firing if someone outside replied on the thread meanwhile.
	cancel_on_reply INTEGER NOT NULL DEFAULT 1,
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fired', 'cancelled')),
	action_id TEXT,
	created_at TEXT NOT NULL,
	fired_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_timers_due ON agent_timers(status, fire_at);
