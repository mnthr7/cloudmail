-- Booking pages, v2: where the meeting happens, what to ask, extra guests,
-- reminders, and a private link for the guest to reschedule or cancel.

-- none | video | phone_guest (you call them) | phone_host (they call you) | in_person | custom.
-- The detail (link, number, address) is the existing `location` column.
ALTER TABLE booking_pages ADD COLUMN location_kind TEXT NOT NULL DEFAULT 'none';
-- off | optional | required.
ALTER TABLE booking_pages ADD COLUMN ask_phone TEXT NOT NULL DEFAULT 'off';
-- Up to five: [{"id","label","long","required"}].
ALTER TABLE booking_pages ADD COLUMN questions_json TEXT NOT NULL DEFAULT '[]';
-- The guest may invite up to three more people.
ALTER TABLE booking_pages ADD COLUMN allow_guests INTEGER NOT NULL DEFAULT 0;
-- Reminder to the guest this many minutes before. 0: none.
ALTER TABLE booking_pages ADD COLUMN reminder_minutes INTEGER NOT NULL DEFAULT 1440;

ALTER TABLE bookings ADD COLUMN guest_phone TEXT;
ALTER TABLE bookings ADD COLUMN answers_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE bookings ADD COLUMN extra_guests_json TEXT NOT NULL DEFAULT '[]';
-- The guest's zone, for writing times in their reminder.
ALTER TABLE bookings ADD COLUMN guest_timezone TEXT;
-- SHA-256 of the private link's token (/book/manage#<token>). The link itself
-- goes only to the main guest, in their own copy of the invite, and changes
-- every time the meeting is moved.
ALTER TABLE bookings ADD COLUMN manage_token_hash TEXT;
-- Every guest's address key (main and extra), for the per-person limit.
ALTER TABLE bookings ADD COLUMN guest_keys_json TEXT NOT NULL DEFAULT '[]';
-- confirmed | cancelled.
ALTER TABLE bookings ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed';
ALTER TABLE bookings ADD COLUMN cancelled_at TEXT;
ALTER TABLE bookings ADD COLUMN cancel_reason TEXT;
ALTER TABLE bookings ADD COLUMN reschedule_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN reminder_sent_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_manage ON bookings(manage_token_hash);
CREATE INDEX IF NOT EXISTS idx_bookings_reminders ON bookings(status, reminder_sent_at, start_at);
CREATE INDEX IF NOT EXISTS idx_bookings_event ON bookings(event_id);

-- Every email a booking page causes (invites, updates, cancellations), by
-- recipient count, so a page can't be used to mail people over and over.
CREATE TABLE IF NOT EXISTS booking_sends (
	id TEXT PRIMARY KEY,
	page_id TEXT NOT NULL REFERENCES booking_pages(id) ON DELETE CASCADE,
	booking_id TEXT,
	kind TEXT NOT NULL,
	recipients INTEGER NOT NULL,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_booking_sends_page ON booking_sends(page_id, created_at);
