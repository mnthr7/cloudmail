-- When you last opened an inbox tab or the calendar, so they can say what's new
-- since then ("Updates · 3 new"). Scope: 'tab:<category>' or 'calendar'.
CREATE TABLE IF NOT EXISTS seen_marks (
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	scope TEXT NOT NULL,
	seen_at TEXT NOT NULL,
	PRIMARY KEY (user_id, scope)
);
