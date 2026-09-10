\# Database



\## jobs table



Created by `infra/init-db/001\_create\_jobs\_table.sql`.



| Column         | Type                     | Notes                                      |

|----------------|--------------------------|---------------------------------------------|

| id             | UUID, PK                 | Generated via `gen\_random\_uuid()` (pgcrypto)|

| type           | TEXT, NOT NULL           | Job type identifier, e.g. "send\_email"      |

| payload        | JSONB, NOT NULL          | Arbitrary job-specific data                 |

| status         | TEXT, NOT NULL           | Constrained via CHECK, see below            |

| attempt\_count  | INT, NOT NULL, default 0 | Incremented on each processing attempt      |

| max\_attempts   | INT, NOT NULL, default 5 | Retry ceiling before DEAD\_LETTERED          |

| last\_error     | TEXT, nullable           | Most recent failure reason, if any          |

| created\_at     | TIMESTAMPTZ, default now()| Set once, never updated                    |

| updated\_at     | TIMESTAMPTZ, default now()| Updated by application code on state change|



\### Status values (enforced by CHECK constraint)

`QUEUED`, `PROCESSING`, `COMPLETED`, `FAILED`, `RETRYING`, `DEAD\_LETTERED`



The database itself rejects any other value — this is enforced at the

schema level, not just in application code, so a bug in the app cannot

write an invalid status.



\### Indexes

\- `jobs\_pkey` — primary key on `id`

\- `idx\_jobs\_status` — supports filtering/listing jobs by status, which

&#x20; the dashboard and `GET /api/jobs?status=...` will rely on later



\### Not yet implemented

\- `job\_attempts` table (full per-attempt history) — deferred until we

&#x20; build actual retry logic in Phase 4; adding it now would be guessing

&#x20; at its shape before we have real requirements

\- `updated\_at` auto-maintenance — currently the application is

&#x20; responsible for setting it on every update; no trigger yet, since

&#x20; explicit updates are simpler to reason about at this stage


## Phase 3 update

- attempt_count incremented every time a job transitions to PROCESSING.
  max_attempts is NOT yet enforced anywhere (Phase 4).
- last_error populated on FAILED, cleared (NULL) on COMPLETED.
- updated_at now explicitly set by the worker on every status transition.


## Phase 4 update

- RETRYING and DEAD_LETTERED statuses (present in the CHECK constraint
  since the original Phase 1 migration) are now actively written by the
  worker.
- FAILED is retired going forward -- the worker no longer writes it.
  Existing Phase 3 rows with status=FAILED remain unchanged (no backfill
  migration performed).
- attempt_count continues to increment on every PROCESSING transition,
  regardless of how many times a job has already been retried.
- max_attempts remains fixed at its DEFAULT 5 (Phase 1 schema); not yet
  configurable per-job via the API (deliberately deferred -- see
  engineering-decisions.md).


## Phase 5 update -- atomic claim query

claimJob() (replaces Phase 3/4's markProcessing):

```sql
UPDATE jobs
SET status = 'PROCESSING', attempt_count = attempt_count + 1, updated_at = now()
WHERE id = $1
  AND (
    status IN ('QUEUED', 'RETRYING')
    OR (status = 'PROCESSING' AND updated_at < now() - ($2 * interval '1 second'))
  )
RETURNING *
```

No new index required: the query is located via the existing primary
key index on id; the status/staleness condition is evaluated against
that single row, not used as a separate index scan predicate.

markCompleted/markRetrying/markDeadLettered now include
`AND status = 'PROCESSING'` as a defense-in-depth precondition. Not the
primary correctness mechanism (claimJob's atomicity is) -- protects
against any future code path calling these out of the expected order.


## Phase 6 update -- replay columns

Migration: infra/init-db/002_phase6_replay_columns.sql

New columns on jobs:
- total_attempt_count (INT, default 0) -- lifetime count of successful
  worker claims across ALL replay cycles. Incremented in the SAME
  atomic UPDATE as claimJob's attempt_count increment (Phase 5's
  WHERE clause and locking semantics are otherwise UNCHANGED).
  IMPORTANT: this is an aggregate counter only. There is no
  job_attempts table, so this does NOT provide a detailed per-attempt
  history (timestamps, individual errors, etc. for each attempt) --
  only the lifetime total.
- replay_count (INT, default 0) -- lifetime count of explicit replay
  operations. Incremented only by the API's claimReplay function.
- last_dead_lettered_at (TIMESTAMPTZ, nullable) -- set by
  markDeadLettered, NEVER cleared by replay or subsequent success.
- last_dead_letter_reason (TEXT, nullable) -- same lifecycle as above.

No new index required (both new atomic queries -- claimJob and
claimReplay -- are located via the existing primary key index on id).

No CHECK constraint change -- DEAD_LETTERED and QUEUED were already
valid status values since Phase 1; only a new transition between
existing values was added, not a new value.

### Real verified data (from actual test execution)

Job 03a4cfcd-72d3-4e32-925d-5bef85425ceb after replay-to-success:
status=COMPLETED, attempt_count=1, total_attempt_count=6 (5 original
exhausted attempts + 1 post-replay claim), replay_count=1,
last_dead_lettered_at IS NOT NULL=true -- concrete proof that
total_attempt_count correctly aggregates across the replay boundary
and that dead-letter history survives eventual success.


## Phase 6 update -- replay columns (schema verified against live DB)

Migration: infra/init-db/002_phase6_replay_columns.sql -- the ONLY
schema migration added in Phase 6.

Applied via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` directly against
the running container, NOT via a fresh volume init. The project's
init-db scripts only execute automatically on a PostgreSQL container's
first initialization (empty data volume); since this volume already
held Phase 1-5 data, running the migration manually against the live
database was the correct, non-destructive method.

Verified via `information_schema.columns` (not just `\d jobs` visual
inspection):

| Column | Type | Nullable | Default |
|---|---|---|---|
| total_attempt_count | integer | NO | 0 |
| replay_count | integer | NO | 0 |
| last_dead_lettered_at | timestamp with time zone | YES | NULL |
| last_dead_letter_reason | text | YES | NULL |

All four match the approved design exactly. No new index required (both
claimJob and claimReplay locate their target row via the existing
primary key index). No CHECK constraint change -- DEAD_LETTERED and
QUEUED were already valid values since Phase 1.

### IMPORTANT -- precise semantics, no detailed attempt history exists

There is NO job_attempts table. Therefore:
- total_attempt_count is an AGGREGATE lifetime counter (total successful
  worker claims across ALL replay cycles) -- it does NOT record
  individual attempt timestamps, individual errors per attempt, or which
  cycle (original vs. which replay) each claim belonged to.
- replay_count is a lifetime count of explicit replay operations only.
- last_dead_lettered_at / last_dead_letter_reason describe only the MOST
  RECENT dead-letter event -- prior dead-letter events (e.g. from an
  earlier replay cycle that also failed) are overwritten, not preserved
  individually.

### Real verified data points

- Job dbf275f3... (replay to success): total_attempt_count=6 (5
  original exhausted + 1 replay claim), replay_count=1,
  last_dead_lettered_at unchanged from the original exhaustion (no new
  dead-letter event occurred, since the job succeeded)
- Job 2c45f4f0... (retry after replay, dead-lettered again):
  total_attempt_count=10 (5+5), replay_count=1,
  last_dead_lettered_at UPDATED to the second (most recent) exhaustion
  timestamp -- directly demonstrates the "most recent event only"
  semantics