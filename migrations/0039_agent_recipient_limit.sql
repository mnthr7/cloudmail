-- How many emails agents may send one person in 24 hours before this agent
-- stops (the loop guard, A14). Counts every agent's sends to that person.
-- 3 by default, as before; 0 means no limit. The owner sets it per agent.
ALTER TABLE agents ADD COLUMN max_sends_per_recipient INTEGER NOT NULL DEFAULT 3;
