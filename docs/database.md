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

