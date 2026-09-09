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

