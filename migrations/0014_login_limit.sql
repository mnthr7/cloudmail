-- Failed sign-ins per client IP and per account, counted in a fixed window.
CREATE TABLE IF NOT EXISTS login_failures (
	key TEXT PRIMARY KEY,
	count INTEGER NOT NULL DEFAULT 0,
	window_start TEXT NOT NULL
);
