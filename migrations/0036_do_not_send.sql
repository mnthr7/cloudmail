-- Marketing mail: a do-not-send list, unsubscribe links, and a flag on the
-- outbound row so the send path knows to add List-Unsubscribe and a footer.

-- One row per address that must not get mail. scope is a sending domain
-- (unsubscribed from rititech.app only) or '*' (every domain: the address
-- hard-bounced, so it does not exist).
CREATE TABLE IF NOT EXISTS do_not_send (
	id TEXT PRIMARY KEY,
	address TEXT NOT NULL,
	scope TEXT NOT NULL,
	reason TEXT NOT NULL CHECK (reason IN ('unsubscribed', 'bounced', 'complained', 'manual')),
	detail TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	UNIQUE (address, scope)
);
CREATE INDEX IF NOT EXISTS idx_do_not_send_address ON do_not_send(address);

-- The token in a recipient's unsubscribe link, one per (domain, address).
-- Random, so a link can't be guessed or forged for someone else.
CREATE TABLE IF NOT EXISTS unsubscribe_links (
	token TEXT PRIMARY KEY,
	scope TEXT NOT NULL,
	address TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	UNIQUE (scope, address)
);

ALTER TABLE emails ADD COLUMN is_marketing INTEGER NOT NULL DEFAULT 0;
