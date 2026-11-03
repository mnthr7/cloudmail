-- Failed sign-ins per client IP and per account, counted in a fixed window.
CREATE TABLE IF NOT EXISTS login_failures (
	key TEXT PRIMARY KEY,
	count INTEGER NOT NULL DEFAULT 0,
	window_start TEXT NOT NULL
);

-- Browsers that have signed in to an account before. Only a hash of the cookie
-- token is kept. A known device skips the shared per-account count, so a flood
-- of wrong passwords from elsewhere can't lock the owner out.
CREATE TABLE IF NOT EXISTS login_devices (
	token_hash TEXT PRIMARY KEY,
	account TEXT NOT NULL,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_devices_account ON login_devices(account, created_at);
