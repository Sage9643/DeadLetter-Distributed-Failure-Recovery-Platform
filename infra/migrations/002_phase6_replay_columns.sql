-- Phase 6: replay support. Attempt semantics (see engineering-decisions.md):
--   attempt_count        = per-replay-cycle retry budget (reset to 0 on replay)
--   total_attempt_count  = lifetime count of successful worker claims across
--                          ALL replay cycles (aggregate only -- there is no
--                          job_attempts table, so this is NOT a detailed
--                          per-attempt history)
--   replay_count         = lifetime count of explicit replay operations
--   last_dead_lettered_at / last_dead_letter_reason = metadata from the most
--                          recent DEAD_LETTERED event; NEVER cleared by
--                          replay or subsequent success, preserving the fact
--                          that this job previously exhausted its retry
--                          policy or hit a non-retryable failure
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS total_attempt_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS replay_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_dead_lettered_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS last_dead_letter_reason TEXT NULL;