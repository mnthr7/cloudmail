-- Native calendar (step 1): calendars, events, and repeating events.
-- CloudMail is the source of truth. Times are stored as wall-clock time plus
-- an IANA zone, so a repeating 9:00 meeting stays at 9:00 through
-- daylight-saving changes; start_at / end_at hold the UTC span of the first
-- occurrence for range queries. The shape follows iCalendar (UID, SEQUENCE,
-- RRULE, EXDATE, RECURRENCE-ID) so invites and phone sync can use it directly.

-- One or more calendars per principal: people now, agents later.
CREATE TABLE IF NOT EXISTS calendars (
	id TEXT PRIMARY KEY,
	workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
	owner_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	color TEXT NOT NULL DEFAULT 'blue',
	-- Default zone for new events on this calendar.
	timezone TEXT NOT NULL DEFAULT 'UTC',
	is_default INTEGER NOT NULL DEFAULT 0,
	-- SHA-256 of the secret subscribe link's token. Null: no link.
	feed_token_hash TEXT UNIQUE,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calendars_owner ON calendars(owner_principal_id);

CREATE TABLE IF NOT EXISTS calendar_events (
	id TEXT PRIMARY KEY,
	calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
	-- iCalendar UID: shared by a series and its edited occurrences.
	uid TEXT NOT NULL,
	-- Bumped on every change, so invite updates and phones know which is newer.
	sequence INTEGER NOT NULL DEFAULT 0,
	title TEXT NOT NULL,
	description TEXT,
	location TEXT,
	all_day INTEGER NOT NULL DEFAULT 0,
	-- "2026-11-10T09:00" for timed events, "2026-11-10" for all-day ones.
	-- All-day end is exclusive, as in iCalendar.
	start_local TEXT NOT NULL,
	end_local TEXT NOT NULL,
	timezone TEXT NOT NULL,
	start_at TEXT NOT NULL,
	end_at TEXT NOT NULL,
	-- Repeating series only.
	rrule TEXT,
	-- Wall-clock starts of skipped occurrences (EXDATE), as a JSON array.
	exdates_json TEXT NOT NULL DEFAULT '[]',
	-- When a series stops (UNTIL), as UTC. Null: forever, or a COUNT.
	repeat_until_at TEXT,
	-- An edited single occurrence points at its series and says which one it replaces.
	parent_id TEXT REFERENCES calendar_events(id) ON DELETE CASCADE,
	recurrence_local TEXT,
	status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'tentative', 'cancelled')),
	-- busy, or free (shown, but doesn't block time).
	transparency TEXT NOT NULL DEFAULT 'busy' CHECK (transparency IN ('busy', 'free')),
	created_by_principal_id TEXT REFERENCES principals(id) ON DELETE SET NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE (calendar_id, uid, recurrence_local)
);
CREATE INDEX IF NOT EXISTS idx_events_range ON calendar_events(calendar_id, start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_events_series ON calendar_events(calendar_id, rrule, repeat_until_at);
CREATE INDEX IF NOT EXISTS idx_events_parent ON calendar_events(parent_id);
-- One series per UID in a calendar (the table's UNIQUE lets NULLs repeat).
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_uid ON calendar_events(calendar_id, uid) WHERE parent_id IS NULL;
-- One default calendar per person, so two first visits at once can't make two.
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendars_default ON calendars(owner_principal_id) WHERE is_default = 1;
