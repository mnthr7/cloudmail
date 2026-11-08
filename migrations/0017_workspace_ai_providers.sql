-- Each workspace brings its own AI provider key, set by an admin on the Admin
-- page. Keys are encrypted with AES-GCM under AI_KEY_ENCRYPTION_KEY, a Worker
-- secret, so a copy of the database alone can't reveal them.

CREATE TABLE IF NOT EXISTS workspace_ai_providers (
	workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
	-- Which provider the key is for. Only Anthropic so far.
	provider TEXT NOT NULL CHECK (provider IN ('anthropic')),
	-- v1.<iv>.<ciphertext>, both base64. Bound to the workspace and provider.
	key_sealed TEXT NOT NULL,
	-- The key's last four characters, so admins can tell keys apart.
	key_hint TEXT NOT NULL,
	set_by_principal_id TEXT REFERENCES principals(id) ON DELETE SET NULL,
	updated_at TEXT NOT NULL,
	-- Set when the provider turns the key down during a run. Agents in the
	-- workspace wait until an admin saves a working key.
	rejected_at TEXT,
	PRIMARY KEY (workspace_id, provider)
);

-- Every time a key is set or removed. Never holds the key itself.
CREATE TABLE IF NOT EXISTS workspace_ai_provider_events (
	id TEXT PRIMARY KEY,
	workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
	provider TEXT NOT NULL,
	action TEXT NOT NULL CHECK (action IN ('set', 'removed', 'rejected')),
	key_hint TEXT,
	by_principal_id TEXT REFERENCES principals(id) ON DELETE SET NULL,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_provider_events ON workspace_ai_provider_events(workspace_id, created_at);
