-- Follow-ups after the meeting (docs/specs/demo-role-end-to-end.md, R12). The
-- host replies to the prep brief with rough notes; the agent drafts a
-- follow-up to the guest from them, for the host to approve. With no notes
-- two hours after the meeting, it drafts a general one.

-- A random reference printed in the brief. Only the host's mailbox ever sees
-- it, so a reply that points back to mail carrying it is the host's own.
ALTER TABLE booking_briefs ADD COLUMN token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_briefs_token ON booking_briefs(token);
-- notes | general, once drafted; or skipped_<why>.
ALTER TABLE booking_briefs ADD COLUMN follow_up TEXT;
-- The queued action (a reply on the guest's thread), or the draft in the host's Drafts.
ALTER TABLE booking_briefs ADD COLUMN follow_up_ref TEXT;
-- The host's reply the notes came from.
ALTER TABLE booking_briefs ADD COLUMN notes_email_id TEXT;
ALTER TABLE booking_briefs ADD COLUMN follow_up_at TEXT;
