-- The owner can let an external agent send on its own straight away, without
-- first collecting 20 human approvals (docs/specs/external-agents.md). The
-- daily limit, recipient scope and the do-not-send list still apply.
ALTER TABLE agents ADD COLUMN trusted_to_send INTEGER NOT NULL DEFAULT 0;
