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
- `GET /api/jobs` (list/filter)
- `POST /api/jobs/:id/retry`, `/replay`
- `GET /api/jobs/:id/attempts`
- `GET /api/stats`
- Authentication/authorization


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