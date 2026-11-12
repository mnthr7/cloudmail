-- Prep briefs (docs/specs/demo-role-end-to-end.md, R11): on the meeting day,
-- the agent running a booking page emails the host who's coming and what to
-- focus on.

-- When the brief goes out, as minutes after midnight on the meeting day in the
-- page's time zone (420 = 7:00). -1: no briefs. A meeting booked after that
-- time, or starting within the hour after it, gets its brief an hour before.
ALTER TABLE booking_pages ADD COLUMN brief_minute INTEGER NOT NULL DEFAULT 420;

-- One brief per booking per start time: a moved meeting gets a fresh one.
-- The row is also the claim, so two cron ticks never send the same brief.
CREATE TABLE IF NOT EXISTS booking_briefs (
	id TEXT PRIMARY KEY,
	booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
	for_start TEXT NOT NULL,
	workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
	-- The agent that wrote it, whose monthly budget its model call counts against.
	agent_principal_id TEXT REFERENCES agents(principal_id) ON DELETE SET NULL,
	-- sending -> sent | failed. A failed send is tried again, three times in all.
	status TEXT NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'failed')),
	attempts INTEGER NOT NULL DEFAULT 1,
	-- What the company lookup found: site | personal (a free mail domain) | unreachable.
	company TEXT,
	-- How the suggested focus went: written | no_key | budget | failed.
	focus TEXT,
	error TEXT,
	model TEXT,
	input_tokens INTEGER NOT NULL DEFAULT 0,
	output_tokens INTEGER NOT NULL DEFAULT 0,
	cost_micros INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	sent_at TEXT,
	UNIQUE (booking_id, for_start)
);
CREATE INDEX IF NOT EXISTS idx_booking_briefs_agent ON booking_briefs(agent_principal_id, created_at);
