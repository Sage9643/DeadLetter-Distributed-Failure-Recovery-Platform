# API

## POST /api/jobs

Submit a new job for asynchronous processing.

**Request body:**
```json
{
  "type": "send_email",
  "payload": { "to": "test@example.com" }
}
```

- `type` — required, non-empty string
- `payload` — required, JSON object (contents are job-type-specific,
  not validated here)

**Success response — `201 Created`:**
```json
{ "jobId": "c90bedc7-030e-4ebb-9914-a1be070f86f2", "status": "QUEUED" }
```

**Validation failure — `400 Bad Request`:**
```json
{
  "error": "Invalid request",
  "details": { "type": { "_errors": ["Invalid input: expected string, received undefined"] } }
}
```

## GET /api/jobs/:id

Fetch a job by id.

**Success — `200 OK`:** full job row (id, type, payload, status,
attempt_count, max_attempts, last_error, created_at, updated_at)

**Not found — `404 Not Found`:**
```json
{ "error": "Job not found" }
```

## GET /api/health

Liveness check. Returns `{ "status": "ok" }`.

## Not yet implemented

(Corrected during the Phase 16 final audit: this list was stale --
`GET /api/jobs`, `POST /api/jobs/:id/replay`, and `GET /api/stats` were
all implemented in later phases and are documented further down in
this same file. Leaving a contradicted "not yet implemented" list
standing next to the sections that implement those same endpoints was
itself a documentation defect, not just an omission.)

- `GET /api/jobs/:id/attempts` -- genuinely still not implemented, by
  deliberate design: there is no `job_attempts` table (see
  `docs/engineering-decisions.md`), so there is no per-attempt history
  to serve. `total_attempt_count`/`replay_count` on `GET /api/jobs/:id`
  remain the only attempt-related data available, and are explicitly
  documented as aggregate-only.
- `POST /api/jobs/:id/retry` -- not planned as a separate manual
  endpoint. Retry is automatic: a failed, non-exhausted job is
  requeued by the worker via the RabbitMQ retry queue's TTL+DLX
  mechanism (see `docs/message-flow.md`), with no operator action
  involved. `POST /api/jobs/:id/replay` is the one manual,
  operator-triggered re-queue action this system provides, and it is
  scoped to `DEAD_LETTERED` jobs only.
- Authentication/authorization -- still accurate as of this writing.
  See `docs/security.md` (Phase 16) for the current state and plan.


## POST /api/jobs/:id/replay

Explicitly re-queues a DEAD_LETTERED job for reprocessing through the
normal worker lifecycle.

**Success -- `200 OK`:**
```json
{ "jobId": "...", "status": "QUEUED", "replayCount": 1 }
```

**Job not in DEAD_LETTERED state -- `409 Conflict`:**
```json
{ "error": "Job is not in a replayable state", "currentStatus": "COMPLETED" }
```
Verified real responses include currentStatus values of COMPLETED and
QUEUED (the latter specifically from a losing concurrent replay
attempt -- see development-log.md).

**Job does not exist -- `404 Not Found`:**
```json
{ "error": "Job not found" }
```

**Malformed :id (not valid UUID syntax) -- `400 Bad Request`:**
```json
{ "error": "Invalid job id format" }
```
This validation was added specifically because Incident 4 (Phase 5)
demonstrated that an invalid UUID reaching PostgreSQL raises error code
22P02 unhandled. Verified with a real malformed id ("not-a-uuid").

## GET /api/jobs/:id -- updated

Now also returns `400 {"error":"Invalid job id format"}` for a
malformed :id, for the same reason as above (retrofitted alongside the
new replay route rather than left inconsistent). Verified with a real
request.

## State-machine rules for replay eligibility

| Current status | Replay result |
|---|---|
| DEAD_LETTERED | Allowed |
| COMPLETED | 409 (verified real) |
| PROCESSING | 409 (not independently exercised this phase, but structurally identical WHERE clause to the verified COMPLETED case) |
| QUEUED | 409 (verified real, as the losing side of the concurrent-replay test) |
| RETRYING | 409 (not independently exercised this phase; see engineering-decisions.md for rationale) |
| does not exist | 404 (verified real) |


## POST /api/jobs/:id/replay (Phase 6, verified)

Explicitly re-queues a DEAD_LETTERED job for reprocessing through the
normal worker lifecycle.

**Success -- `200 OK`:**
```json
{ "jobId": "...", "status": "QUEUED", "replayCount": 1 }
```
Verified real (multiple jobs, e.g. e25c2f4a..., dbf275f3..., 2c45f4f0...).

**Job not in DEAD_LETTERED state -- `409 Conflict`:**
```json
{ "error": "Job is not in a replayable state", "currentStatus": "..." }
```
Verified real for all five other statuses:
- COMPLETED (job 2ca21851..., naturally occurring)
- QUEUED (the losing side of a genuine concurrent replay race)
- PROCESSING (deterministically forced via direct SQL, then replayed --
  see development-log.md for method)
- RETRYING (same method)

**Job does not exist -- `404 Not Found`:** verified real.

**Malformed :id -- `400 Bad Request`:**
```json
{ "error": "Invalid job id format" }
```
Verified real. Added specifically because Incident 4 (Phase 5)
demonstrated an invalid UUID reaching PostgreSQL raises error code
22P02 unhandled.

**Known limitation -- publish failure after successful DB claim:**
verified real (RabbitMQ deliberately stopped during testing): the
atomic DEAD_LETTERED->QUEUED claim can succeed while the subsequent
publish fails, leaving the job QUEUED with no message ever sent and no
automatic recovery. See incidents-and-failures.md and
failure-handling.md.

## GET /api/jobs/:id -- updated (Phase 6, verified)

Now also returns `400 {"error":"Invalid job id format"}` for a
malformed :id. Verified real.


## GET /api/stats (Phase 8)

PostgreSQL-backed aggregate operational stats. Does not query RabbitMQ.

**Response -- `200 OK`:**
```json
{
  "totalJobs": 123,
  "byStatus": { "QUEUED": 5, "PROCESSING": 2, "RETRYING": 3, "COMPLETED": 100, "DEAD_LETTERED": 10, "FAILED": 3 },
  "totalReplays": 12,
  "totalAttempts": 245,
  "pendingOutboxEvents": 0
}
```
`pendingOutboxEvents` was added in Phase 10 (transactional outbox) --
this example was updated during the Phase 16 final audit to include
it; the field itself has been present in every real response since
Phase 10, this doc's example JSON had simply never been refreshed to
show it.

Verified real via seeded-state integration test (2 tests, both passing).
See observability.md for full field derivation and what this endpoint
deliberately does not measure.

## GET /api/health (Phase 8: reclassified as liveness, behavior unchanged)

Unchanged from Phase 1. `200 {"status":"ok"}`. No dependency checks.
Now explicitly documented as the liveness endpoint, distinct from the
new readiness endpoint below.

## GET /api/health/ready (Phase 8, new)

Dependency readiness check. Real `SELECT 1` against PostgreSQL, real
`checkQueue()` against RabbitMQ.

**All dependencies reachable -- `200 OK`:**
```json
{ "postgres": "ok", "rabbitmq": "ok" }
```

**Any dependency unreachable -- `503 Service Unavailable`:**
```json
{ "postgres": "ok", "rabbitmq": "error" }
```
Verified real (3 tests: liveness unchanged, readiness success, readiness
failure with mocked RabbitMQ failure). See observability.md for the
relationship to Incident 5.


## GET /api/jobs (Phase 9, new)

Fixed recent-activity list for the dashboard. No pagination this phase.

**Response -- `200 OK`:**
```json
{
  "jobs": [
    { "id": "...", "type": "...", "status": "...", "attempt_count": 0, "max_attempts": 5, "created_at": "...", "updated_at": "..." }
  ]
}
```
- Ordered by `updated_at DESC` (most recently ACTIVE, not merely most
  recently created)
- `LIMIT 20`, fixed, no query parameters
- Returns only the 7 fields listed above -- not every job column (that
  remains GET /api/jobs/:id's role)

Verified real: 3 integration tests (empty table, ordering/limit with 25
seeded rows, exact field-set assertion), 2 supertest route tests.

## WebSocket endpoint: ws://<host>/ws (Phase 9, new)

Notification-only channel, attached to the same HTTP server/port as the
REST API. Never carries authoritative job data.

**Event contract:**
```json
{ "type": "job.updated", "jobId": "...", "status": "...", "updatedAt": "..." }
```

On receipt, clients are expected to refetch via the REST endpoints
above (GET /api/stats, GET /api/jobs, GET /api/jobs/:id) rather than
trust the event payload. See observability.md and
engineering-decisions.md for the full missed-event-recovery rationale
and the PostgreSQL polling design (including startup cursor strategy).

Verified real: a genuine WebSocket server + real client connection over
a real ephemeral local port, asserting the client actually receives a
broadcast event matching the exact contract above.


## GET /api/stats -- updated (Phase 10)

Added one field, `pendingOutboxEvents` -- count of outbox_events rows
with published_at IS NULL (durable work not yet successfully published
to RabbitMQ). Computed via a scalar subquery in the same single
aggregate SELECT already used for every other stats field -- still one
query, one round trip.

```json
{
  "totalJobs": 123,
  "byStatus": { "...": "..." },
  "totalReplays": 12,
  "totalAttempts": 245,
  "pendingOutboxEvents": 0
}
```

## POST /api/jobs/:id/replay -- updated (Phase 10)

Response shape and status codes (200/404/409/400) are UNCHANGED. The
internal mechanism changed: the route handler no longer calls
publishJobCreated directly. claimReplay now atomically writes the
DEAD_LETTERED->QUEUED transition and a pending outbox_events row in one
transaction; the actual RabbitMQ publish happens asynchronously via the
outbox dispatcher. See architecture.md and engineering-decisions.md.

## POST /api/jobs -- updated (Phase 12: rate limiting + backpressure)

Two new middleware run BEFORE createJob() is ever reached: a rate
limiter, then a backpressure check. Either can short-circuit the
request with zero database writes. See engineering-decisions.md for
why these are separate, route-agnostic-vs-DeadLetter-specific concerns
rather than one combined middleware.

**Rejected by rate limiter -- `429 Too Many Requests`:**
```json
{ "error": "Too many requests", "reason": "rate_limited" }
```
Includes a `Retry-After` header (seconds, integer, derived from the
actual token-bucket refill rate for that client -- not a fixed
constant). Verified real via rateLimiter.test.ts, rateLimiter.
concurrency.test.ts, rateLimiterRoute.test.ts (real Express route +
real Postgres), and the k6 rate-limit-backpressure scenario -- 25,777
real 429 responses in the scenario's first (synthetic-environment)
execution, 3,145 in the second, authoritative real Docker Compose
execution (see load-testing.md).

**Rejected by backpressure -- `503 Service Unavailable`:**
```json
{
  "error": "Service temporarily unable to accept new jobs",
  "reason": "backpressure",
  "pendingOutboxEvents": 51
}
```
`pendingOutboxEvents` is the actual value that triggered the rejection
(a fresh getStats() call, not cached), not the configured threshold.
`Retry-After: 5` always (fixed, unlike the rate limiter's derived
value -- see engineering-decisions.md for why a fixed value was judged
sufficient here). Verified real via backpressure.test.ts (deterministic
seeded Postgres state, real Express route) and a genuine RabbitMQ
outage (see load-testing.md's Phase 12 chaos-test section).

Default thresholds (env-configurable, NOT experimentally-proven
production capacity numbers -- see engineering-decisions.md):
`RATE_LIMIT_CAPACITY=100`, `RATE_LIMIT_WINDOW_SECONDS=60`,
`BACKPRESSURE_THRESHOLD=50`.

## POST /api/jobs/:id/replay -- updated (Phase 12: rate limiting only)

Shares the SAME rate-limit bucket as POST /api/jobs (one client's
create-job and replay traffic draw from one combined budget, not two
independent ones) -- can now also return `429` with the identical
shape documented above. Verified real via rateLimiterRoute.test.ts.

Deliberately NOT subject to backpressure -- a replay request can
succeed (200) even while pendingOutboxEvents is far over threshold.
Verified real via backpressure.test.ts's dedicated exemption test and
via manual observation during the Phase 12 chaos test. See
engineering-decisions.md for why.

## Test-only header: X-Test-Client-Id (Phase 12)

Read by the rate limiter's client-identity logic ONLY when
`NODE_ENV !== "production"`. Overrides `req.ip` for that request. This
is NOT a security or trust mechanism -- unlike `req.ip`, which a client
cannot spoof from outside the trust boundary Express is configured
with (`app.set("trust proxy", 1)` in `apps/api/src/app.ts`, trusting
exactly the one reverse-proxy hop this project's production topology
actually has -- see that file and `docs/security.md` for the full
rationale; a bare `trust proxy: false` was used here before the Phase
17 final audit found it silently broke per-client rate limiting once
Phase 16 put nginx in front of the API), this header is trivially
spoofable by any caller. It exists purely so tests and k6 runs (which,
run from a single host, would otherwise all share one source IP) can
exercise per-client rate-limit behavior deterministically. Ignored
entirely in production -- verified real via rateLimiter.test.ts's
"production ignoring X-Test-Client-Id" suite.