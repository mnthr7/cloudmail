-- Spam is its own mailbox, separate from Trash. Messages leave Inbox/Sent
-- when is_spam is set, and come back when it is cleared.

ALTER TABLE emails ADD COLUMN is_spam INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_emails_spam ON emails(user_id, is_spam);
