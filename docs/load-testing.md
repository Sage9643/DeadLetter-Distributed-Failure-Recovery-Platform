# Load Testing

## Status: Scenarios A, B, and C executed with real results. Scenarios
D and E not yet implemented.

## Tooling

k6 (standalone binary, v2.2.0, installed via `winget install k6
--source winget`), run manually from the repository root against a
locally-running API/worker pair. Not containerized, not wired into any
CI (see architecture.md's "Note on CI/CD" -- no CI currently exists in
this repository).

## Database isolation

A third logical PostgreSQL database, `deadletter_load`, in the same
container already running `deadletter` and `deadletter_test`. Created
and migrated (001, 002, 003) identically to `deadletter_test`'s Phase 7
bootstrap. The API and worker are pointed at it via a real
`DATABASE_URL` environment-variable override at process launch (not by
editing any checked-in `.env`), so no application code was modified to
achieve this isolation.

`tests/load/verify/verifyDb.js` guards every operation (including the
destructive `reset` mode) behind the same `assertLoadDatabase()` check
pattern as `apps/api` and `apps/worker`'s existing `testDb.ts` helpers
-- it queries `SELECT current_database()` and refuses to proceed unless
connected to exactly `deadletter_load`. This was verified twice: once
by deliberately connecting to `deadletter_test` (correctly rejected),
once by connecting to `deadletter_load` (correctly accepted).

## Scenario A -- Harness Smoke Test (not a performance benchmark)

Purpose: validate the harness itself -- k6 installation, explicit
target configuration, HTTP connectivity, the full API -> PostgreSQL ->
RabbitMQ -> worker path, database isolation, and the verifyDb.js
verification script -- before attempting any real load measurement.

Configuration: 2 VUs, 10s duration, load_test_normal job type,
one worker process.

Result: 20 iterations, 100% success (20/20 submit status is 201
checks passed), 0 HTTP failures. All 20 jobs reached COMPLETED,
confirmed via verifyDb.js, real exit code 0.

This run's latency/throughput numbers are explicitly NOT recorded
here as a performance benchmark -- the scenario file itself states
this, and it is restated here for the same reason: 2 VUs is not a
meaningful load level, only a connectivity/harness proof.

## Scenario B -- Concurrent Submissions

Purpose: generate genuine concurrent HTTP load against
POST /api/jobs and verify, via PostgreSQL directly, that every
submitted job completes exactly once (no double-claim) under that
load -- corroborating Phase 5's atomic-claim guarantee at volume,
rather than re-deriving it.

Configuration (actual, as executed):
- 10 VUs
- 20 second duration (k6's own banner additionally reported a 50s max
  duration including a 30s graceful stop allowance, which did not
  extend the actual run -- the run itself completed in 20.0s per k6's
  final summary)
- No sleep() between iterations -- unlike Scenario A's paced ~1
  request/VU/second, VUs submitted back-to-back for the full duration
- load_test_concurrent job type
- Two competing worker processes running concurrently against
  deadletter_load throughout the run and the subsequent drain

k6-reported results (real, from the executed run):
- 4,813 iterations / HTTP requests
- 100.00% checks succeeded (4,813 / 4,813 submit status is 201)
- 0.00% http_req_failed (0 out of 4,813)
- http_req_duration: avg 40.69ms, min 10.24ms, med 33.59ms, max
  338.03ms, p90 65.04ms, p95 86.41ms
  (k6's output did not report p50 or p99 as separate labeled values --
  none are stated here; "med" above is k6's own median figure)
- Approximately 240 requests/sec (240.326581/s, as reported by k6)

PostgreSQL-verified results (the authoritative pass/fail source, via
node tests/load/verify/verifyDb.js concurrent):
- Exactly 4,813 job rows found with type = load_test_concurrent --
  matching k6's iteration count exactly
- All 4,813 reached status = COMPLETED
- 0 jobs with attempt_count > 1 -- every single job was claimed
  and completed in exactly one attempt
- Script exited 0, printed PASS

Drain observation (NOT a performance benchmark -- an informal,
irregularly-spaced series of manual polls during verification, recorded
here only as a qualitative observation that completion progressed
steadily with two workers running):

Approximately: 220 -> 626 -> 1490 -> 2314 -> 2729 -> 3430 -> 4813
completed, checked at uneven, non-precisely-timed intervals during
polling. attempt_count > 1 was checked and confirmed at 0 at every
single one of these intermediate polls, not only at the final one.

## Explicit scope of the Scenario B result

This result validates the system's behavior under this particular
local workload (10 VUs, 20 seconds, two workers, one machine) and
corroborates the Phase 5 atomic-claim guarantee at real volume (4,813
jobs) rather than a single hand-timed job. It is NOT a general
scalability claim -- no conclusion is drawn here about behavior at
higher VU counts, different hardware, multiple API instances, or
sustained/repeated runs. It does NOT prove or claim exactly-once
processing, and it does NOT exercise or claim anything about
exactly-once publication -- the outbox's documented duplicate-
publication window (crash between a successful RabbitMQ publish and
markOutboxPublished committing) is untouched by this scenario and
remains proven separately, deterministically, in
apps/api/src/__tests__/integration/dispatcher.test.ts. See
failure-handling.md and engineering-decisions.md for that limitation's
full documentation.

## Limitations and anomalies actually observed (Scenario B)

- No index currently exists on jobs.updated_at or on jobs.type;
  Scenario B's verification queries (filtering by type and
  attempt_count) ran without issue at this data volume (4,813 rows),
  but this was not measured as an indexing/query-performance concern --
  only correctness was being verified.
- The PROCESSING count observed during intermediate polls varied (2,
  then 1, then 2) rather than staying constant -- consistent with
  prefetch(1) per worker and the query simply catching each worker at
  a different point in its claim/process/ack cycle at the instant of
  each poll. Not treated as an anomaly; noted for completeness.
- No other anomaly was observed. No HTTP failure, no unexpected job
  status, no double-claim, no stalled drain.

## Scenario C -- Retryable Failure (DLQ Exhaustion)

Purpose: submit jobs guaranteed to fail every attempt
(payload.shouldFail=true, the existing deterministic test hook in
apps/worker/src/processors/jobProcessor.ts, unchanged since Phase 4)
and verify, via PostgreSQL, that each one fully exhausts the existing,
unmodified retry policy (backoff 2s/4s/8s/16s, max_attempts=5) and
reaches DEAD_LETTERED with correct attempt-count and dead-letter
metadata -- exercising the existing retry/DLQ path at real HTTP-
submitted volume, not altering it.

Configuration (actual, as executed):
- k6 executor: shared-iterations, 2 VUs, 10 total iterations,
  maxDuration 30s
- load_test_failing job type, payload { shouldFail: true }
- One worker process running against deadletter_load throughout

k6-reported results (real, from the executed run):
- 10 iterations / HTTP requests
- 100.00% checks succeeded (10 / 10 submit status is 201)
- 0.00% http_req_failed (0 out of 10)
- http_req_duration: avg 9.77ms, min 7.67ms, med 9.18ms, max 12.65ms,
  p90 12.04ms, p95 12.34ms
  (k6's output did not report p50 or p99 as separate labeled values --
  none are stated here)
- k6's own run wall time: ~0.1s (submission itself is near-instant;
  the retry/backoff/exhaustion process happens asynchronously
  afterward, not during k6's run window -- see below)

PostgreSQL-verified results (the authoritative pass/fail source, via
node tests/load/verify/verifyDb.js failing):

An immediate check run right after k6 completed showed all 10 jobs
still RETRYING, 0 DEAD_LETTERED -- correctly reported as FAIL (exit
code 1), since the backoff schedule alone requires a minimum ~30
seconds (2s+4s+8s+16s) between a job's first and fifth attempt. This
FAIL was expected and is recorded here as an honest intermediate
result, consistent with how Scenario B's intermediate polls were
recorded.

A second check, run after waiting approximately 35-40 seconds, showed:
- Exactly 10 job rows found with type = load_test_failing -- matching
  k6's iteration count exactly
- All 10 reached status = DEAD_LETTERED (0 remained in any other
  status)
- 0 jobs with attempt_count != max_attempts -- every job reached
  DEAD_LETTERED via full retry exhaustion (5 attempts), not via the
  non-retryable/immediate-DLQ path
- 0 jobs with a NULL last_dead_letter_reason
- 0 jobs with a NULL last_dead_lettered_at
- Script exited 0, printed PASS

## Explicit scope of the Scenario C result

This result validates the system's behavior under this particular
small, fixed-volume local workload (10 jobs, one worker) and
corroborates that the existing retry/backoff/DLQ mechanism (originally
proven in Phases 4-6 via single hand-timed jobs) behaves correctly when
driven by real HTTP-submitted load rather than a manually created job.
It is NOT a general scalability claim -- no conclusion is drawn about
behavior with a much larger number of simultaneously-failing jobs, nor
about total drain time as a function of volume (this project's worker
ACKs and becomes free immediately after scheduling a retry; the
backoff delay lives in RabbitMQ's retry-queue TTL, not in worker
occupancy -- so drain time for N failing jobs is NOT simply
proportional to N x 30s, though this run did not attempt to measure or
characterize that relationship precisely). It does NOT prove or claim
exactly-once processing or publication.

## Limitations and anomalies actually observed (Scenario C)

- No precise drain-time figure (e.g. "N seconds from submission to
  full exhaustion") was captured in this run -- only that an immediate
  check showed 0/10 exhausted and a check after an unmeasured ~35-40s
  wait showed 10/10 exhausted. A future run could capture this more
  precisely (e.g. polling at fixed short intervals) if a specific
  timing figure is needed.
- No other anomaly was observed. No HTTP failure, no unexpected job
  status, no job reaching DEAD_LETTERED via the wrong path (non-
  retryable vs. exhaustion), no missing dead-letter metadata.

## Pending

Scenarios D (outbox backlog during RabbitMQ outage) and E (replay
under concurrency) are designed (see the Phase 11 design discussion)
but not yet implemented or executed.