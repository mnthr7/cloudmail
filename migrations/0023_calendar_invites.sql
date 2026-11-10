-- Calendar step 2: invites. Events you organize carry guests who get real
-- invites by email; invites others send you are kept with the email they came
-- in, and accepting one puts it on your calendar linked back to that email.

-- Someone else organizes it (an invite you accepted). Null: you organize it.
ALTER TABLE calendar_events ADD COLUMN organizer_email TEXT;
ALTER TABLE calendar_events ADD COLUMN organizer_name TEXT;
-- Your answer to someone else's invite: accepted or tentative.
ALTER TABLE calendar_events ADD COLUMN my_status TEXT;
-- The address your own invites go out from (and replies come back to).
ALTER TABLE calendar_events ADD COLUMN send_from TEXT;
-- The email an accepted invite came in, for "open the email" from the event.
ALTER TABLE calendar_events ADD COLUMN source_email_id TEXT REFERENCES emails(id) ON DELETE SET NULL;

-- Guests on an event you organize, and their answers.
CREATE TABLE IF NOT EXISTS calendar_attendees (
	event_id TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
	email TEXT NOT NULL,
	name TEXT,
	-- NEEDS-ACTION, ACCEPTED, TENTATIVE or DECLINED.
	partstat TEXT NOT NULL DEFAULT 'NEEDS-ACTION',
	responded_at TEXT,
	PRIMARY KEY (event_id, email)
);

-- Invites, updates and cancellations that arrived by email.
CREATE TABLE IF NOT EXISTS calendar_invites (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
	uid TEXT NOT NULL,
	-- REQUEST (an invite or update) or CANCEL.
	method TEXT NOT NULL,
	sequence INTEGER NOT NULL DEFAULT 0,
	organizer_email TEXT,
	-- The parsed series and edited occurrences, as JSON, for showing and accepting it.
	event_json TEXT NOT NULL,
	-- Your answer: ACCEPTED, TENTATIVE or DECLINED. Null: not answered.
	response TEXT,
	responded_at TEXT,
	created_at TEXT NOT NULL,
	UNIQUE (email_id, uid)
);
CREATE INDEX IF NOT EXISTS idx_calendar_invites_uid ON calendar_invites(user_id, uid);
CREATE INDEX IF NOT EXISTS idx_events_uid_lookup ON calendar_events(uid);
