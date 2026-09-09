# Failure Handling

## Current state (Phase 3)

Job lifecycle: QUEUED -> PROCESSING -> COMPLETED | FAILED

- PROCESSING: attempt_count incremented, set when the worker picks up a message
- COMPLETED: processing succeeded, last_error cleared
- FAILED: processing threw an error, last_error stores the message. Currently
  a TERMINAL state - no retry, no backoff, no DLQ yet (Phase 4).

## Message acknowledgement strategy

| Scenario | Action |
|---|---|
| Malformed message | ACK (discard) |
| Job id not found in DB | ACK (discard) |
| Job already COMPLETED/FAILED | ACK (skip, likely redelivery) |
| DB error while fetching/marking PROCESSING | NACK + requeue (infra failure) |
| processJob() throws | markFailed(), then ACK (business-logic failure, terminal for now) |
| processJob() succeeds | markCompleted(), then ACK |

## Terminal-state guard — explicitly NOT full idempotency

The guard is a plain status check ("if this job is already COMPLETED or
FAILED, skip it") performed when a message is received. It prevents the
common redelivery case observed in Phase 2 (worker crashes after finishing
work but before ACK) from reprocessing a job that already reached a
terminal state.

It does NOT:
- Use any locking or atomic claim mechanism
- Protect against two workers concurrently receiving the same redelivered
  message and both passing the guard check before either writes PROCESSING
- Guarantee exactly-once processing of any kind

RabbitMQ provides at-least-once delivery, never exactly-once. True
idempotency (safe under genuine concurrent races) is Phase 5 scope.

## Known limitations (deliberately deferred)

- No retry policy or exponential backoff - FAILED is terminal (Phase 4)
- No DLQ - failed jobs are simply marked FAILED and removed from the queue (Phase 4)
- Terminal-state guard is not a distributed lock (see above)
- NACK+requeue on DB errors has no backoff - could hot-loop if Postgres is
  down for a sustained period