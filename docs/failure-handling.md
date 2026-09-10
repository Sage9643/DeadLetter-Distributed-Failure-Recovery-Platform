# Failure Handling

## Current state (Phase 4)

Job lifecycle: QUEUED -> PROCESSING -> COMPLETED | RETRYING -> ... -> DEAD_LETTERED

- PROCESSING: attempt_count incremented, set when the worker picks up a message
- COMPLETED: processing succeeded, last_error cleared
- RETRYING: processing failed, retryable, attempts remain — scheduled for
  reprocessing after a backoff delay
- DEAD_LETTERED: processing failed and either (a) attempt_count reached
  max_attempts, or (b) the failure was classified non-retryable — terminal,
  no further automatic action this phase
- FAILED: retained in the schema for Phase 3 historical rows only. The
  worker no longer writes this status as of Phase 4.

## Retry policy

Exponential backoff: `delayMs = min(2000 * 2^(attemptCount-1), 20000)`

| attempt_count at failure | delay before retry |
|---|---|
| 1 | 2s |
| 2 | 4s |
| 3 | 8s |
| 4 | 16s |
| 5 (default max_attempts) | none — dead-lettered |

## Retryable vs non-retryable classification

- Any error thrown by the processor is treated as **retryable** by default,
  subject to the max_attempts check above.
- A processor can throw `NonRetryableError` to signal the failure should
  **never** be retried, regardless of remaining attempts — dead-lettered
  immediately.
- Test hooks: `payload.shouldFail=true` (retryable), 
  `payload.shouldFailPermanently=true` (non-retryable).

## RabbitMQ retry mechanism

No delayed-message plugin used. A dedicated retry queue
(`deadletter.jobs.retry.queue`) has no queue-level TTL; each retry message
is published with its own per-message `expiration` (the calculated backoff,
in ms). When that TTL expires, RabbitMQ's native dead-letter-exchange
mechanism automatically routes the message back into the main processing
exchange/queue — this delay-then-redeliver behavior is provided entirely
by default RabbitMQ, not custom code.

## Message acknowledgement strategy (updated)

| Scenario | Action |
|---|---|
| Malformed message | ACK (discard) |
| Job id not found in DB | ACK (discard) |
| Job already COMPLETED/FAILED/DEAD_LETTERED | ACK (skip, likely redelivery) |
| Job status RETRYING on receipt | NOT skipped — proceeds to reprocessing (this is the retry mechanism) |
| DB error while fetching/marking PROCESSING | NACK + requeue (infra failure) |
| processJob() throws NonRetryableError | markDeadLettered(), publish to DLQ, then ACK |
| processJob() throws, attempts exhausted | markDeadLettered(), publish to DLQ, then ACK |
| processJob() throws, attempts remain | markRetrying(), publish to retry queue with backoff TTL, then ACK |
| DB/publish error while recording retry/DLQ outcome | NACK + requeue (infra failure) |
| processJob() succeeds | markCompleted(), then ACK |

## Terminal-state guard — explicitly NOT full idempotency

Unchanged in nature from Phase 3: a plain status check, no locking, no
protection against a genuine race between two workers processing the same
redelivered message concurrently. Updated in Phase 4 to also treat
DEAD_LETTERED as terminal, and to explicitly NOT treat RETRYING as
terminal (a RETRYING job redelivered via TTL expiry must be reprocessed).

## Known limitations (deliberately deferred)

- DLQ is not consumed or inspectable yet — messages accumulate in
  `deadletter.jobs.dlq` with no automated or manual review path (Phase 6)
- No replay mechanism (Phase 6)
- Terminal-state guard is not a distributed lock (Phase 5)
- NACK+requeue on DB/publish errors has no backoff — could hot-loop under
  a sustained outage
- RabbitMQ per-message TTL only expires messages at the head of the
  queue — under mixed TTLs in the retry queue, expiry order is not
  strictly guaranteed by RabbitMQ's implementation. Not expected to
  matter at this project's scale/testing, but noted as a known RabbitMQ
  behavior, not a bug in our code.

  
## Phase 5 test-mechanism correction (pre-execution)

CLAIM_TEST_DELAY_MS (relative, per-message delay) was replaced with
CLAIM_TEST_SYNC_EPOCH_MS (absolute shared target timestamp) before any
tests were executed, after review determined the relative-delay
approach could not reliably guarantee two independent worker processes'
claim attempts genuinely overlap in time. See engineering-decisions.md
for full rationale. claimJob() itself is unaffected -- this is a
test-harness-only change.

Test 3's actual guarantee was also clarified: it demonstrates rejection
of a duplicate delivered AFTER a job is already COMPLETED (terminal
exclusion), not a live PROCESSING-state race -- that guarantee is
demonstrated by Test 4 alone, which is the only test using >= 2
concurrent consumers.


## Phase 6 -- Replay

### Attempt semantics (Option C, chosen over resetting or preserving cumulatively)

Three options were evaluated:
- Reset attempt_count to 0 alone: works for retry policy, but loses the
  lifetime-attempts fact entirely.
- Preserve attempt_count cumulatively (never reset): this is a
  correctness bug, not a valid alternative. If a job dead-letters at
  attempt_count=5 (max_attempts=5) and replay left attempt_count at 5,
  the very next claim increments to 6, and the exhaustion check
  (attempt_count >= max_attempts) is immediately true -- the job would
  dead-letter on its first post-replay attempt with zero retries.
- Chosen: reset attempt_count to 0 on replay (fresh per-cycle retry
  budget, so Phase 4's exhaustion logic works completely unchanged) AND
  add total_attempt_count as a separate, never-reset lifetime counter.

Verified real evidence: job 6d0addf3-921c-47f5-86bb-ca495545d415's
post-replay worker log shows "attempt":1 (not 2), confirming the reset
genuinely took effect before the increment.

### DLQ interaction

See message-flow.md. PostgreSQL remains authoritative; the DLQ message
is left as an inert historical artifact after replay. Verified: DLQ
Ready count (10) did not decrease after a replayed job reached
COMPLETED.

### Duplicate/concurrent replay protection

A single atomic conditional UPDATE, structurally identical to Phase 5's
claimJob pattern -- no preliminary SELECT:

```sql
UPDATE jobs SET status='QUEUED', attempt_count=0, replay_count=replay_count+1, ...
WHERE id=$1 AND status='DEAD_LETTERED'
RETURNING *
```

Verified under a genuine race (not merely "ran it twice and it looked
fine"): two replay requests fired within 5ms of each other via a
PowerShell Start-Job script, both independently delayed 3000ms
(REPLAY_TEST_DELAY_MS, test-only), both reached the atomic claim within
14ms of each other (raw epoch timestamps: 1789048066488 vs
1789048066502). The losing request's rejection reported
currentStatus="QUEUED" -- not a stale DEAD_LETTERED read -- direct
evidence it evaluated against the row AFTER the winner had already
committed, i.e. genuine contention at the database layer. Final
replay_count=1, not 2, confirming only one UPDATE actually took effect.

### Why RETRYING is rejected, not replayable

A RETRYING job already has an automatic TTL-based retry scheduled via
the existing RabbitMQ retry queue (Phase 4). Allowing manual replay in
this state would race a manual message against the automatic one for
no benefit, and was rejected rather than building a second retry path.
Not independently tested this phase (no test forced a job into
RETRYING at the moment a replay was attempted), but the WHERE clause
(status='DEAD_LETTERED' only) structurally guarantees this rejection --
same mechanism verified against COMPLETED and QUEUED.

### Known limitations (honest, not hidden)

- total_attempt_count is an AGGREGATE lifetime counter only. There is
  no job_attempts table; this phase does NOT provide detailed
  per-attempt history (individual timestamps/errors per attempt).
- Replay introduces the same dual-write risk already tracked since
  Phase 0/2: if the DEAD_LETTERED->QUEUED UPDATE succeeds but the
  subsequent publish fails, the job remains QUEUED with no message ever
  sent, and no worker will discover it. Not solved here -- consistent
  with the project's standing decision not to implement an outbox
  pattern without further evidence/need.
- PROCESSING and RETRYING rejection paths were not independently
  exercised with a dedicated test this phase (relying on the shared
  atomic WHERE clause's structural guarantee, verified directly against
  COMPLETED and QUEUED).
- No DLQ listing/inspection endpoint this phase (deferred to future
  dashboard work, per Q7).


## Phase 6 -- Replay (Verified)

### Attempt semantics -- verified real

attempt_count resets to 0 on replay (confirmed via worker log showing
"attempt":1 immediately post-replay, not a continuation of the prior
count). total_attempt_count and replay_count both verified incrementing
correctly across multiple real replay cycles (see database.md for exact
figures).

### Duplicate/concurrent replay protection -- verified real

Single atomic conditional UPDATE, WHERE status='DEAD_LETTERED', no
preliminary SELECT -- structurally identical to Phase 5's claimJob.

Evidence (REUSED from the earlier deterministic concurrency-test
session -- NOT re-executed during this verification pass, per explicit
instruction): job 26a1f8db..., two replay requests fired 5ms apart via
a PowerShell Start-Job script, both independently delayed
(REPLAY_TEST_DELAY_MS, test-only), both reached "Attempting replay
claim" 14ms apart. Winner: 200. Loser: 409, currentStatus="QUEUED" (the
winner's post-state, not a stale DEAD_LETTERED read -- direct evidence
of genuine database-layer contention). Final replay_count=1, not 2.

### Invalid-state rejection -- verified real, all six cases

| State | Method used | Result |
|---|---|---|
| DEAD_LETTERED | Real | 200 (multiple jobs) |
| COMPLETED | Real, naturally occurring | 409 |
| QUEUED | Real, naturally occurring (concurrent-replay loser) | 409 |
| PROCESSING | Deterministically forced via direct SQL UPDATE, then replayed | 409 |
| RETRYING | Same method | 409 |
| Nonexistent UUID | Real | 404 |
| Malformed UUID | Real | 400 |

PROCESSING and RETRYING were forced rather than caught naturally,
because both states are extremely short-lived in this system (claims
resolve in single-digit-to-low-double-digit milliseconds in every
observed log) -- this is an honest, deliberate testing technique
(identical in spirit to Phase 5's staleness test), not a simulated
result. The request itself and its response are real.

### Redelivery / failure-loop safety -- verified real

Malformed/nonexistent UUID: structurally cannot cause a redelivery loop
on this path, since POST /api/jobs/:id/replay is a plain HTTP
request/response with no AMQP ACK/NACK/requeue mechanism involved before
the id is validated. Confirmed by code inspection plus real 400/404
responses.

Publish-failure scenario: REPRODUCED FOR REAL, not left unverified.
RabbitMQ was deliberately stopped; a replay was attempted; the atomic
DB claim succeeded (job 7c305a47... moved to QUEUED, replay_count=1)
but the publish failed with a raw, unhandled 500 (IllegalOperationError:
Channel closed). After RabbitMQ was restarted and confirmed healthy,
the job remained QUEUED indefinitely -- no automatic recovery. This is
a real, reproduced instance of the DB/RabbitMQ dual-write limitation
tracked since Phase 0/2, now confirmed on the replay path specifically.
See incidents-and-failures.md.

### DLQ interaction -- verified real

See message-flow.md. Confirmed via real RabbitMQ UI checks: Ready count
unaffected by replay in both the re-failure and eventual-success cases.

### Phase 4/5 regression -- verified real

Stale-PROCESSING reclaim (Phase 5) re-tested: job 91842b6d... was
manually backdated to PROCESSING with a 90s-stale updated_at, then a
worker successfully reclaimed and completed it via the SAME WHERE
clause Phase 5 verified -- confirming Phase 6's only change to
claimJob (adding a total_attempt_count increment to the same atomic
UPDATE) did not affect the staleness-reclaim branch.

### Known limitations (honest, not hidden)

- total_attempt_count/replay_count are AGGREGATE lifetime counters
  only -- no job_attempts table exists, so no detailed per-attempt
  history (individual timestamps/errors per attempt, or which replay
  cycle each attempt belonged to) is available.
- DB/RabbitMQ dual-write gap on the replay path: reproduced for real,
  not solved (consistent with the project's standing decision not to
  implement an outbox pattern without further evidence/need).
- API RabbitMQ channel does not auto-recover after a broker restart --
  reproduced for real, requires manual API restart. See
  incidents-and-failures.md.
- Basic replay's intermediate QUEUED/attempt_count=0 state (between the
  replay claim and the worker picking it up) was NOT CAPTURED during
  verification -- the worker consistently claimed faster than
  sequential manual commands could observe. This is an observational
  limitation of manual testing, not a claim that the state doesn't
  exist or behaves incorrectly.