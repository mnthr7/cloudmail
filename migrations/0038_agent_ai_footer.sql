-- The owner can turn off the "is an AI assistant working with ..." line an
-- agent adds to the mail it sends. On by default, so existing agents keep it.
ALTER TABLE agents ADD COLUMN ai_footer INTEGER NOT NULL DEFAULT 1;
