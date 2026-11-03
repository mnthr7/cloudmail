ALTER TABLE emails ADD COLUMN send_at TEXT;
ALTER TABLE emails ADD COLUMN undo_inbox INTEGER NOT NULL DEFAULT 0;
ALTER TABLE emails ADD COLUMN reply_to_header TEXT;
ALTER TABLE emails ADD COLUMN source_email_id TEXT;
ALTER TABLE emails ADD COLUMN draft_action TEXT;
ALTER TABLE addresses ADD COLUMN signature_html TEXT;
ALTER TABLE user_preferences ADD COLUMN undo_send_seconds INTEGER NOT NULL DEFAULT 10;
