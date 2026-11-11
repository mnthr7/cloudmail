-- Calendar step 3: calendars that come from somewhere else (Google, iCloud,
-- Outlook) through their secret iCal link. They are read-only copies,
-- refreshed every 15 minutes, and count as busy time for booking pages.
-- The link is a password to that calendar, so it's stored sealed
-- (AES-GCM under the Worker's AI_KEY_ENCRYPTION_KEY), never in plain text.
ALTER TABLE calendars ADD COLUMN source_url_sealed TEXT;
-- Where it comes from, for display only ("calendar.google.com").
ALTER TABLE calendars ADD COLUMN source_host TEXT;
-- 1: copy titles and places. 0: copy only the times, as "Busy".
ALTER TABLE calendars ADD COLUMN source_details INTEGER NOT NULL DEFAULT 0;
ALTER TABLE calendars ADD COLUMN source_synced_at TEXT;
ALTER TABLE calendars ADD COLUMN source_error TEXT;
-- Hash of the last file read, so an unchanged feed isn't rewritten.
ALTER TABLE calendars ADD COLUMN source_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_calendars_source ON calendars(source_synced_at) WHERE source_url_sealed IS NOT NULL;

-- Calendar step 4: booking pages. Anyone with the link picks a free time;
-- it lands on your calendar and they get a real invite.
CREATE TABLE IF NOT EXISTS booking_pages (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	-- The public link: /book/<slug>.
	slug TEXT NOT NULL UNIQUE,
	title TEXT NOT NULL,
	description TEXT,
	-- Meeting lengths offered, in minutes, as a JSON array.
	durations_json TEXT NOT NULL DEFAULT '[30]',
	timezone TEXT NOT NULL,
	-- Weekly hours: {"MO": [["09:00","17:00"]], ...} in the page's zone.
	hours_json TEXT NOT NULL,
	buffer_minutes INTEGER NOT NULL DEFAULT 0,
	min_notice_minutes INTEGER NOT NULL DEFAULT 240,
	horizon_days INTEGER NOT NULL DEFAULT 30,
	-- Most bookings a day, so the page can't be used to flood a calendar.
	max_per_day INTEGER NOT NULL DEFAULT 8,
	-- The calendar bookings go on, and the address invites come from.
	calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
	send_from TEXT,
	location TEXT,
	enabled INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_booking_pages_user ON booking_pages(user_id);

CREATE TABLE IF NOT EXISTS bookings (
	id TEXT PRIMARY KEY,
	page_id TEXT NOT NULL REFERENCES booking_pages(id) ON DELETE CASCADE,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	event_id TEXT REFERENCES calendar_events(id) ON DELETE SET NULL,
	guest_name TEXT NOT NULL,
	guest_email TEXT NOT NULL,
	-- The address without +tags (and, for Gmail, dots), for the per-guest limit.
	guest_key TEXT NOT NULL DEFAULT '',
	note TEXT,
	start_at TEXT NOT NULL,
	end_at TEXT NOT NULL,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_user_time ON bookings(user_id, start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_bookings_page_created ON bookings(page_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bookings_page_guest ON bookings(page_id, guest_key, start_at);
