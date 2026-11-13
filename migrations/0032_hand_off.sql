-- Take over and hand off (docs/specs/demo-role-end-to-end.md, R15).

-- Why an agent handed the thread to its owner (by_principal_id is then the
-- agent). Null when the owner took it over themselves.
ALTER TABLE thread_takeovers ADD COLUMN reason TEXT;
-- Booking reminders still go out on a taken-over thread only when the owner
-- turns them back on (1). Otherwise nothing automatic happens on it.
ALTER TABLE thread_takeovers ADD COLUMN reminders INTEGER NOT NULL DEFAULT 0;

-- Hand-off used to be in every agent's settings at "on its own" without doing
-- anything (it had no tool). Now it writes to the sender, so it starts off for
-- every agent already hired; the owner turns it on on the Staff page.
UPDATE agent_versions
SET definition_json = json_set(definition_json, '$.capabilities.hand_off.level', 'off')
WHERE json_extract(definition_json, '$.capabilities.hand_off.level') IS NOT NULL;
