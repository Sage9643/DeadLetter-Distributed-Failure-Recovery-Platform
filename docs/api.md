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