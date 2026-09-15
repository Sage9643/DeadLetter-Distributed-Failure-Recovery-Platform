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