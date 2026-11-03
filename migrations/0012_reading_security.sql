ALTER TABLE email_attachments ADD COLUMN scan_status TEXT NOT NULL DEFAULT 'skipped';
ALTER TABLE email_attachments ADD COLUMN vt_analysis_id TEXT;
ALTER TABLE email_attachments ADD COLUMN scan_malicious INTEGER;

CREATE INDEX idx_attachments_scan ON email_attachments(scan_status, created_at);

CREATE TABLE trusted_image_senders (
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	address TEXT NOT NULL COLLATE NOCASE,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	PRIMARY KEY (user_id, address)
);

ALTER TABLE user_preferences ADD COLUMN vt_malicious_threshold INTEGER NOT NULL DEFAULT 1;
