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



## Scenario D -- Outbox Backlog During RabbitMQ Outage

Purpose: deliberately stop RabbitMQ, submit jobs via real k6-generated
load while it is down, and verify -- via PostgreSQL directly -- that
the existing, unmodified transactional outbox (Phase 10) durably
records and later publishes every job once RabbitMQ recovers, with the
full chain (job creation -> durable outbox record -> eventual publish
-> worker consumption -> COMPLETED) completing correctly and with zero
job loss. This is the same class of guarantee already proven with one
manually-created job in Phase 10's Deliberate Test 4; this scenario
exercises it at k6-generated volume rather than re-deriving it.

Configuration (actual, as executed):
- k6 executor: shared-iterations, 2 VUs, 10 total iterations,
  maxDuration 30s
- load_test_outage job type, empty payload (no shouldFail -- this
  scenario tests outbox durability, not the worker's retry policy,
  which is Scenario C's concern)
- RabbitMQ deliberately stopped (docker compose stop rabbitmq) BEFORE
  the k6 run, confirmed via docker compose ps (only deadletter-postgres
  shown healthy)

k6-reported results (real, from the executed run, with RabbitMQ
genuinely down throughout):
- 10 iterations / HTTP requests
- 100.00% checks succeeded (10 / 10 submit status is 201) -- every
  submission succeeded DESPITE RabbitMQ being unreachable, directly
  confirming job creation does not depend on RabbitMQ reachability
- 0.00% http_req_failed (0 out of 10)
- http_req_duration: avg 60.85ms, min 10.43ms, med 12.75ms, max
  256.56ms, p90 254.95ms, p95 255.75ms

Real observed anomaly (not predicted in advance, recorded honestly):
request latency was visibly higher and more variable during this
outage run (p95 255.75ms) than in Scenario C's baseline under healthy
RabbitMQ (p95 12.34ms), even though createJob's transaction never
directly calls RabbitMQ. Root cause was not definitively identified in
this run -- possible explanations include Postgres connection-pool
contention from concurrent outbox-insert transactions, or some other
factor -- and is recorded here as an open, unexplained observation
rather than a confirmed diagnosis.

GET /api/stats observation during the outage (live HTTP check, not the
authoritative pass/fail source -- see below): totalJobs:10,
byStatus.QUEUED:10, pendingOutboxEvents:10 -- confirming the full
backlog was durably recorded in PostgreSQL with nothing silently lost.

Recovery sequence (real, as executed):
1. RabbitMQ restarted (docker compose start rabbitmq), confirmed
   healthy via docker compose ps before proceeding
2. First GET /api/stats check immediately after RabbitMQ reported
   healthy: pendingOutboxEvents was ALREADY 0 -- the outbox dispatcher
   published the entire backlog essentially immediately upon RabbitMQ
   becoming reachable again, with no observed delay worth recording as
   a duration figure
3. However, COMPLETED remained 0 (byStatus.QUEUED:10) across two
   consecutive checks after that -- investigated directly rather than
   assumed to be normal drain time

Real process gap discovered during this run (documented honestly, not
smoothed over): investigation found NO WORKER PROCESS WAS RUNNING
against deadletter_load at all during the outage/recovery observation
window (the worker terminal had been closed earlier in this session
when the development environment was restarted, and was not
re-verified as part of this scenario's setup checklist before
proceeding). This was NOT a RabbitMQ-reconnection failure of any kind
-- once a worker was started, all 10 jobs completed within the very
next check. This is recorded as a genuine gap in this scenario's
execution process (a missing pre-flight check that a worker is
actually running), not a system defect. A future run of this scenario
should explicitly verify worker process liveness as part of its setup
steps, the same way API/RabbitMQ health is already checked.

PostgreSQL-verified results (the authoritative pass/fail source, via
node tests/load/verify/verifyDb.js outage, run after the above gap was
resolved by starting a worker):
- Exactly 10 job rows found with type = load_test_outage -- matching
  k6's iteration count exactly
- All 10 reached status = COMPLETED
- 0 outbox_events rows for these jobs remain unpublished
  (published_at IS NULL)
- Script exited 0, printed PASS

## Explicit scope of the Scenario D result

This result validates the system's behavior under this particular
small, fixed-volume local outage-and-recovery workload (10 jobs, one
worker, one deliberate RabbitMQ outage) and corroborates, at
k6-generated volume, the same outbox-durability guarantee Phase 10's
Deliberate Test 4 first proved with a single manually-created job. It
is NOT a general scalability claim -- no conclusion is drawn about
backlog size limits, outage duration limits, or behavior under a much
larger concurrent backlog. It does NOT prove or claim exactly-once
publication or processing -- the outbox's documented duplicate-
publication window (a crash between a successful RabbitMQ publish and
markOutboxPublished committing) is untouched by this scenario and
remains proven separately, deterministically, in
apps/api/src/__tests__/integration/dispatcher.test.ts. This scenario
also does NOT touch, exercise, or make any claim about Incident 5
(Phase 6, the API's cached RabbitMQ channel not auto-recovering after
a broker restart) -- the API's outbox dispatcher's publish attempts
were observed to succeed immediately upon RabbitMQ's recovery in this
run, which is consistent with Incident 5 remaining unfixed but simply
not being triggered by this particular scenario's timing; no claim is
made here about whether Incident 5's failure mode was avoided by
design or by circumstance.

## Limitations and anomalies actually observed (Scenario D)

- Real, unexplained request-latency increase during the outage
  (p95 255.75ms vs. Scenario C's healthy-RabbitMQ baseline of
  p95 12.34ms) -- root cause not identified in this run.
- A real process gap: no worker was running during initial
  observation, discovered via direct investigation (checking the
  worker terminal and GET /api/stats showing zero progress across
  repeated checks) rather than assumed. Once corrected, the outbox and
  worker both behaved correctly.
- The outbox dispatcher's recovery-to-first-successful-publish timing
  was too fast to measure precisely in this run (pendingOutboxEvents
  was already 0 on the very first post-recovery check) -- no more
  precise "outage recovery latency" figure is available from this run.
- No other anomaly was observed. No job was lost. No duplicate
  publication was observed (though this scenario was not designed to
  detect one, and does not claim to have tested for it -- see
  dispatcher.test.ts for the deterministic duplicate-publication
  proof).



## Scenario E -- Replay Under Concurrency

Purpose: seed a fixed number of DEAD_LETTERED jobs directly via SQL,
then fire concurrent POST /:id/replay requests deliberately targeting
the SAME job IDs from multiple iterations, and verify -- via
PostgreSQL directly -- that claimReplay's existing atomic conditional
UPDATE (Phase 6, unmodified) allows at most one successful claim per
job, corroborating the single-job proof from Phase 6's Deliberate Test
5 at real k6-generated concurrent volume.

Configuration (actual, as executed, after a harness fix -- see
Real incident below):
- 20 jobs seeded directly via SQL (tests/load/verify/seedReplayJobs.js)
  as DEAD_LETTERED, attempt_count=max_attempts=5, replay_count=0, with
  populated last_dead_lettered_at/last_dead_letter_reason -- the exact
  terminal state the real retry pipeline (Scenario C, Phases 4-6)
  produces, seeded directly to isolate replay-claim correctness from
  DLQ-arrival correctness (already separately proven)
- k6 executor: shared-iterations, 10 VUs, 40 total iterations
  (exactly 2x the seeded job count)
- Deterministic, guaranteed ID reuse: iteration index (via
  exec.scenario.iterationInTest, a genuinely global counter -- see
  incident below) modulo 20 -- every seeded job ID is targeted by
  EXACTLY 2 separate iterations, guaranteeing a real claim race on
  every single job by construction, not by chance
- k6 script targets ONLY POST /api/jobs/:id/replay -- does not call
  POST /api/jobs at all

## Real incident during Scenario E: k6 __ITER is per-VU, not global

**First run result (invalidated, re-run required):** an initial run
used `__ITER` (k6's built-in per-VU iteration counter) to select which
job ID each iteration targeted. Per k6's own documentation and a
directly matching community example, `__ITER` restarts at 0
independently for EACH VU in shared-iterations mode -- it is not a
single sequential counter shared across all VUs. This caused most of
the 40 iterations to redundantly target only the first 5 seeded job
IDs (whichever low index values multiple VUs' independently-restarting
counters happened to reach), while the remaining 15 seeded jobs were
NEVER requested at all. Confirmed via real evidence, not assumed: the
15 untouched jobs' updated_at timestamps matched their original seed
time exactly, while the 5 claimed jobs' timestamps were ~1 minute
later, and only the lowest-index 5 job IDs (in seed-array order) were
ever claimed.

This was a bug in the TEST HARNESS script's ID-selection logic only --
claimReplay, the outbox, and worker claiming were not involved and
were not modified. The atomicity invariant (replay_count never
exceeding 1) held correctly even in this flawed first run, for every
job that WAS actually targeted -- the flaw was incomplete coverage,
not incorrect claiming behavior.

**Fix:** replaced `__ITER` with `exec.scenario.iterationInTest` (from
the k6/execution module) -- k6's documented mechanism for a genuinely
global, monotonically-increasing iteration counter across all VUs in
shared-iterations mode, which is what guaranteed per-job coverage
actually requires. Re-ran the full scenario (fresh reset, fresh seed,
fresh 20 UUIDs) after the fix -- see results below.

k6-reported results (real, from the corrected re-run):
- 40 iterations / HTTP requests
- 100.00% checks succeeded (40 / 40 -- our check accepts BOTH 200 and
  409 as expected, valid outcomes per the real, documented replay
  route contract)
- http_req_failed: 50.00% (20 out of 40) -- this EXACTLY matches the
  predicted 20-winner/20-loser split now that every job received
  genuine 2-way contention, confirming the harness fix worked
  completely (k6's http_req_failed metric counts any non-2xx/3xx
  response as "failed" by default, with no awareness of our custom
  check logic -- the 409s it counts here are the correct, expected
  lost-race outcome, not real failures)
- http_req_duration: avg 47.63ms, min 15.26ms, med 33.53ms, max
  142.44ms, p90 100.86ms, p95 123.45ms

PostgreSQL-verified results (the authoritative pass/fail source, via
node tests/load/verify/verifyDb.js replay):
- Exactly 20 job rows found with type = load_test_replay
- 0 jobs with replay_count > 1 -- the core invariant, holding across
  all 20 genuine concurrent races
- All 20 jobs show replay_count = 1 (every single seeded job was
  successfully claimed by exactly one of its 2 competing requests)
- Of those, 0 failed to reach a legitimate terminal state -- all 20
  reached COMPLETED
- 0 pending outbox events remaining for these jobs
- 0 claimed jobs with an inconsistent attempt_count
- Script exited 0, printed PASS

Independent SQL cross-check (GROUP BY status, replay_count):
COMPLETED | replay_count=1 | count=20
A single, clean row -- no other status or replay_count value exists
anywhere in the seeded set.

## Explicit scope of the Scenario E result

This result validates the system's behavior under this particular
small, fixed-volume local workload (20 seeded jobs, 40 concurrent
replay requests guaranteeing 2-way contention on every job) and
corroborates, at real k6-generated concurrent HTTP volume, the same
atomic-replay-claim guarantee Phase 6's Deliberate Test 5 first proved
with a single job by hand. It is NOT a general scalability claim -- no
conclusion is drawn about behavior with a much larger number of
simultaneously-raced jobs or higher contention factors than 2-way. It
does NOT prove or claim exactly-once delivery or exactly-once
processing -- only exactly-one-successful-replay-claim per job, which
is the real, narrower, correct guarantee this system provides (see
failure-handling.md). The seeded jobs' DEAD_LETTERED starting state
was created directly via SQL, not via the real retry pipeline --
DLQ-arrival correctness itself is separately and already proven in
Scenario C, and is not re-tested here.

## Limitations and anomalies actually observed (Scenario E)

- The k6 __ITER-vs-iterationInTest incident above is the primary
  anomaly of this scenario -- a real, found-and-fixed test-harness bug,
  documented in full rather than silently corrected without record.
- No other anomaly was observed in the corrected run. No job was
  over-claimed. No claimed job failed to reach a terminal state. No
  outbox event was left unpublished. No attempt-counter inconsistency.

## Phase 11 status

Scenarios A, B, C, D, and E have all been implemented and executed
with real, captured evidence. No further load-testing scenarios are
currently planned under the original Phase 11 design.



## Pending

Scenarios D (outbox backlog during RabbitMQ outage) and E (replay
under concurrency) are designed (see the Phase 11 design discussion)
but not yet implemented or executed.