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