-- Phase 10: transactional outbox. Closes the DB/RabbitMQ dual-write gap
-- reproduced in Phase 2 (Deliberate Test 2) and Phase 6 (Deliberate
-- Test 3). See docs/engineering-decisions.md for full rationale.
--
-- IMPORTANT: does NOT provide exactly-once delivery. See
-- docs/failure-handling.md / engineering-decisions.md.
CREATE TABLE IF NOT EXISTS outbox_events (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id       UUID NOT NULL REFERENCES jobs(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    claimed_at   TIMESTAMPTZ NULL,
    published_at TIMESTAMPTZ NULL,
    attempts     INT NOT NULL DEFAULT 0,
    last_error   TEXT NULL
);

-- Partial index: only pending rows are ever queried by the dispatcher.
-- Published rows accumulate but are never scanned by this index.
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events (created_at)
    WHERE published_at IS NULL;