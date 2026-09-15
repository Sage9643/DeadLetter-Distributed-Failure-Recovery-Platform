# Observability

## Status: implemented and verified (Phase 8, real test execution)

## What is measured

### GET /api/stats (PostgreSQL-backed, single query)

```json
{
  "totalJobs": 123,
  "byStatus": { "QUEUED": 5, "PROCESSING": 2, "RETRYING": 3, "COMPLETED": 100, "DEAD_LETTERED": 10, "FAILED": 3 },
  "totalReplays": 12,
  "totalAttempts": 245
}
```

All fields derived directly from existing `jobs` columns via one
conditional-aggregation query (`COUNT(*) FILTER (...)`, `SUM`). No new
schema. `FAILED` is included even though no worker code has written it
since Phase 4 -- real historical rows exist and dropping them from a
"total jobs" count would misrepresent reality.

**This endpoint queries PostgreSQL only. It does NOT query RabbitMQ.**
No AMQP `Ready`/`Unacked` counts, no RabbitMQ management API call, are
part of `/api/stats`. `QUEUED`/`RETRYING` counts from PostgreSQL serve
as an honest, already-available proxy for "work waiting," deliberately
chosen over adding a second protocol/port coupling for the stats
endpoint -- consistent with the same reasoning that rejected RabbitMQ
management API access for DLQ inspection in Phase 6.

### GET /api/health (liveness, unchanged)

Behavior preserved byte-identical from before Phase 8: `200
{"status":"ok"}`, no dependency checks. Answers "is this process
running and able to respond," nothing more.

### GET /api/health/ready (readiness, new)

Performs a real `SELECT 1` against PostgreSQL and a real
`channel.checkQueue()` against RabbitMQ (read-only, idempotent, on the
already-asserted main queue). `200` with `{"postgres":"ok","rabbitmq":"ok"}`
if both succeed; `503` with per-dependency `"ok"`/`"error"` if either
fails. Answers a different question from liveness: "are this API's
actual dependencies currently reachable."

**Relationship to Incident 5 (Phase 6):** Incident 5 demonstrated that
the API's RabbitMQ channel can silently die after a broker restart and
stay dead indefinitely, with zero visibility from the existing liveness
check (which performs no dependency checks at all). This readiness
endpoint would surface that exact failure immediately as a `503`. It
does NOT fix Incident 5's underlying reconnection gap -- the channel
still does not auto-recover, and the API process would still need a
manual restart to actually resolve it. This endpoint only makes the
broken state observable instead of silent; it is a detection
improvement, not a resolution of the underlying limitation.

### Worker log fields (structured, pino, unchanged framework)

Added this phase: `durationMs` on the four terminal log lines (job
completed, dead-lettered via non-retryable, dead-lettered via
exhaustion, scheduled for retry) -- measured from the moment of a
successful atomic claim to the moment of that outcome, in-process, per
attempt. Also added: graceful shutdown logging on SIGTERM/SIGINT
(worker did not previously handle these signals at all -- it now logs
the signal received, closes the RabbitMQ connection cleanly via the
existing `closeConnection()`, and exits).

`pid`/`hostname` (process identity) were already present on every log
line via pino's defaults since Phase 3 -- not new this phase, noted
explicitly since the Phase 8 brief asked for worker/process identity
and it already existed.

## What CANNOT currently be measured, and why

- **Aggregate/persisted processing latency** (e.g. "average completion
  time across all jobs," exposed via an API or stored in the database):
  NOT implemented. `updated_at` is overwritten on every status
  transition, so for any job that was ever retried, it reflects only
  the LATEST transition, not a usable start-to-finish duration. Would
  require a `job_attempts` table (same limitation already documented
  since Phase 1/6) to compute honestly. **The per-attempt `durationMs`
  worker log field described above is real, accurate, and implemented
  -- but it is log-level only, scoped to a single attempt, and is NOT
  aggregated into any persisted or API-exposed metric this phase.**
  These are two different things and should not be conflated.
- **RabbitMQ queue depth** (literal AMQP `Ready` count): deliberately
  not exposed via `/api/stats` -- see above.
- **Correlation ID threading from an API request through to worker log
  lines**: deliberately NOT implemented. The thin `{jobId}` message
  design (Phase 2) is preserved unchanged; no correlation/request ID
  was added to the RabbitMQ message payload or to worker logs this
  phase. `jobId` itself already provides cross-process correlation
  (searchable in both API and worker logs) without adding a new
  message field. This remains an explicit non-goal, not an oversight.

## Design decisions

See engineering-decisions.md for the readiness-endpoint, stats-scope,
and duration-logging rationale in full.

## Test results (real, actually executed)
Total: 38 tests, 0 failures. New this phase: `statsService.test.ts` (2
tests, seeded known DB state -> exact expected aggregate counts) and
`healthRoute.test.ts` (3 tests: liveness unchanged, readiness success
with real Postgres + mocked RabbitMQ, readiness failure with real
Postgres + mocked RabbitMQ failure).

Phase 7 regression: all 33 pre-existing tests re-run and confirmed
still passing, across two full independent test runs.

## Real incidents encountered during Phase 8 (process/authoring issues, not application bugs)

Both documented in full in development-log.md's Phase 8 entry. Summary:
(1) a stats test file was accidentally created in the wrong app
(worker instead of api) during manual file creation, caught via
directory listing and corrected; (2) a full-file replacement of
consumer.ts unintentionally dropped four pre-existing explanatory
comments, caught via `git diff` review before commit and fully
restored, re-verified via a clean diff showing additions only. Neither
incident affected application logic or test outcomes; both were caught
and corrected before this documentation was written.


## Phase 9 -- Real-Time Dashboard Notifications

### Architecture: PostgreSQL polling, not worker push

apps/api runs an internal poller (2-second interval) querying
`SELECT id, status, updated_at FROM jobs WHERE updated_at > $cursor
ORDER BY updated_at ASC`, broadcasting one job.updated WebSocket event
per changed row to all connected dashboard clients. This requires ZERO
changes to apps/worker -- the poller watches PostgreSQL directly
(the existing source of truth), regardless of whether a change
originated from a worker's claimJob/markCompleted/markRetrying/
markDeadLettered or the API's own claimReplay.

### Startup cursor strategy (addresses the historical-broadcast /
missed-update race)

The poller's starting cursor is established via `SELECT now()` run
against PostgreSQL itself (not the Node process's clock), as the very
first action before the poll interval begins. This means:
- Nothing with an updated_at before that instant is ever broadcast
  (no flood of historical jobs on API startup).
- Nothing with an updated_at after that instant is missed (the first
  poll tick's query is WHERE updated_at > cursor, and there is no
  separate "initialization window" -- the cursor IS the first thing
  established).

**Accepted edge case, not engineered around further:** a row updated at
the exact same microsecond as the cursor would be skipped once. No
persistent event table or additional infrastructure was introduced to
close this vanishingly unlikely gap -- REST remains authoritative
regardless, so a skipped notification never produces incorrect
dashboard state, only a delayed one (corrected by the next poll tick
that catches the job's NEXT update, or the dashboard's own 15s periodic
REST refresh, or a manual refresh).

### Missed-event recovery

WebSocket messages are notifications only, never authoritative data.
The dashboard (apps/dashboard/src/App.tsx) refetches via REST on every
received event rather than trusting the event payload, and additionally
performs an independent 15-second periodic REST refresh regardless of
WebSocket state. A dropped connection, a missed message, or the
WebSocket server being entirely unavailable never leaves the dashboard
permanently incorrect -- only temporarily stale until the next
successful REST fetch.

### Reconnection behavior

apps/dashboard/src/ws/useJobEvents.ts implements exponential backoff
reconnection (1s, 2s, 4s... capped at 15s) on disconnect. Connection
state (connecting/open/closed) is surfaced in the dashboard UI header.

### What this does NOT provide

- Not instant push -- bounded by the 2-second poll interval. A job
  transitioning through multiple states within one interval (e.g.
  QUEUED->PROCESSING->COMPLETED inside 2s) is only broadcast once, at
  its final observed state.
- No index currently supports the poller's `WHERE updated_at > $1`
  query -- acceptable at current/demo table sizes; flagged as a future
  consideration if job volume grows substantially, not silently
  ignored.
- Correlation ID propagation through the WebSocket event: not added.
  jobId alone provides sufficient correlation for this notification-
  only channel, consistent with the same reasoning already documented
  for RabbitMQ messages in Phase 8.

## Phase 9 real test results
Total: 17 suites, 62 tests, 0 failures. apps/dashboard build: clean (37
modules, no errors).

### Real incidents encountered and resolved
1. **File-creation copy/paste corruption.** A terminal command
   (`notepad apps\api\src\routes\jobs.ts`) got literally typed into the
   file content instead of run separately, corrupting the first two
   import lines with 21 resulting compile errors. Caught via `npx tsc`
   output, fixed via a full verified-clean file replacement.
2. **Missing vite/client ambient types.** `import "./styles.css"` failed
   type-checking (TS2882) because tsconfig.json's `types` array didn't
   include `vite/client`. Fixed by adding it; verified via a clean
   `npx tsc -b --noEmit` and successful `npm run build`.
3. **Ambiguous test fixture.** App.test.tsx used totalJobs=5 and
   totalAttempts=5 simultaneously, causing `getByText("5")` to
   correctly fail on finding two matching elements (a real test bug,
   not a component bug -- the component rendered correctly). Fixed by
   using distinct fixture values.
4. **Stray shell-redirect artifact files.** Two small files (`e HEAD`,
   `tatus`) appeared as untracked in git status -- confirmed to be
   accidental output-redirection artifacts from earlier terminal
   commands (containing literal `git log`/`git status` output), not
   real project files. Deleted.
5. **Uncommitted build artifact.** `apps/dashboard/tsconfig.tsbuildinfo`
   (tsc's incremental-build cache) appeared as untracked. Added
   `*.tsbuildinfo` to the root .gitignore rather than deleting it once,
   preventing recurrence on future builds.
6. **React act() warnings** in useJobEvents.test.ts (non-failing, but
   noisy) -- mock WebSocket event dispatches happened outside React's
   batching. Fixed by wrapping them in `act()`.

None of these incidents involved application/business logic -- all were
scaffolding, tooling, or test-authoring issues, caught and resolved
before this report.

### Regression verification against commit 7ae6feea35c658196514dfc7f50c4e913ccbe1c0
- apps/worker/src/consumer.ts: absent from diff -- UNCHANGED
- apps/worker/src/services/jobService.ts: absent from diff -- UNCHANGED
- apps/api/src/app.ts: absent from diff -- UNCHANGED (by design --
  see engineering-decisions.md)
- apps/api/src/services/jobService.ts: diff shows ONLY the new
  listRecentJobs function inserted; createJob/getJobById/claimReplay
  unchanged
- apps/api/src/routes/jobs.ts: diff shows ONLY the new GET / handler
  inserted; POST /, GET /:id, POST /:id/replay unchanged
- No migration files added
- claimJob, claimReplay, retry/backoff, DLQ, ACK/NACK, replay semantics:
  all confirmed unchanged by the above

### Known limitations (honest, not hidden)
- Near-real-time only (2s poll bound), not instant push
- No index on jobs.updated_at supporting the poller query yet
- 5 npm audit findings in apps/dashboard's dev-tooling
  (vitest/vite/esbuild) investigated and accepted as dev-server-only
  exposures, not force-upgraded this phase -- see
  engineering-decisions.md
- Dashboard not containerized (consistent with apps/api and
  apps/worker's current state)
- No authentication on the WebSocket endpoint (consistent with the
  REST API, which also has none)
- Incident 5 (RabbitMQ channel non-recovery) and the DB/RabbitMQ
  dual-write gap remain unrelated to and unaffected by this phase