-- API keys for external agents (docs/specs/external-agents.md, X9): for agents
-- that can't do an OAuth sign-in in a browser (Grok's API, scripts, n8n). A
-- key is one more connection of an external agent, so scope, approvals,
-- audit, rate limits and Disconnect are the same as for OAuth.
ALTER TABLE agent_connections ADD COLUMN auth TEXT NOT NULL DEFAULT 'oauth' CHECK (auth IN ('oauth', 'api_key'));
-- SHA-256 of the key (base64). The key itself is shown once and never stored.
ALTER TABLE agent_connections ADD COLUMN key_hash TEXT;
-- The key's first characters, so the founder can tell keys apart.
ALTER TABLE agent_connections ADD COLUMN key_hint TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_connections_key_hash ON agent_connections(key_hash) WHERE key_hash IS NOT NULL;
