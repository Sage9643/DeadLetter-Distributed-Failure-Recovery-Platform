# DeadLetter — Architecture

## Status
Phase 0 — Infrastructure foundation (PostgreSQL + RabbitMQ running locally via Docker Compose)

## High-Level Architecture (target, v1)

Client
  |
  v
API Service
  |
  +-------------> PostgreSQL (source of truth for job state)
  |
  +-------------> RabbitMQ (delivery mechanism)
                       |
                       v
                  Worker Pool
                  /    |    \
               Worker Worker Worker
                  |
             success/failure
                  |
             retry handling
                  |
             Dead Letter Queue
                  |
                  v
             DeadLetter Manager
              /            \
         Dashboard        Replay

## Current State (as of Phase 0)

- PostgreSQL 16 running in Docker, healthy, verified via `psql` query
- RabbitMQ 3.13 (management edition) running in Docker, healthy, verified via management UI login
- No application code yet — API, worker, and dashboard are empty scaffolding
- No queues, exchanges (beyond RabbitMQ defaults), or tables created yet

## Key Design Principle

PostgreSQL is the source of truth for job state. RabbitMQ is the delivery
mechanism, not a system of record. This distinction matters for how retry,
replay, and idempotency are eventually implemented — a message existing (or
not existing) in RabbitMQ is never treated as authoritative; the database
row is.

## Open Design Question (tracked, not yet solved)

**Consistency problem between PostgreSQL and RabbitMQ**: what happens if a
job is written to PostgreSQL successfully but the RabbitMQ publish fails
(or vice versa)? This is a classic dual-write problem. We are deliberately
NOT solving this yet. Once Phase 2 implements the real publish path, we
will attempt to reproduce this failure deliberately, observe actual
behavior, and only then evaluate whether a pattern such as the transactional
outbox is justified. See `docs/engineering-decisions.md` (to be created)
once that analysis happens.

## Infrastructure

See `infra/docker-compose.yml` for service definitions.

- PostgreSQL: port 5432, database `deadletter`, user `deadletter`
- RabbitMQ: AMQP port 5672, management UI port 15672, user `deadletter`

Both services have Docker healthchecks defined so that dependent services
(API, worker — added in later phases) can wait for actual readiness rather
than just container start.


## Phase 3 -- Worker Processing (Job Lifecycle)

The worker now drives the real job lifecycle instead of only logging/ACKing:

1. Re-fetches the job from Postgres by id (source of truth, per Phase 2)
2. If missing or already COMPLETED/FAILED, ACKs and skips (redelivery guard,
   NOT full idempotency -- see failure-handling.md)
3. Marks job PROCESSING (increments attempt_count)
4. Runs processJob() -- currently a stub; throws if payload.shouldFail === true
5. Marks job COMPLETED or FAILED (last_error set on failure)
6. ACKs the message (see message-flow.md and failure-handling.md for the
   full ACK/NACK decision table)

Full lifecycle now enforced: QUEUED -> PROCESSING -> COMPLETED | FAILED.
No retry/backoff/DLQ yet -- FAILED is currently terminal (Phase 4).


## Phase 4 -- Retry, Backoff, and Dead Letter Queue

On processing failure, the worker now classifies and routes the job
instead of leaving it terminally FAILED:

1. NonRetryableError thrown -> DEAD_LETTERED immediately, published to
   deadletter.jobs.dlq
2. Retryable error, attempts remain -> RETRYING, published to
   deadletter.jobs.retry.queue with a per-message TTL (exponential
   backoff). RabbitMQ dead-letters it back to the main queue on expiry.
3. Retryable error, attempts exhausted (attempt_count >= max_attempts)
   -> DEAD_LETTERED, published to deadletter.jobs.dlq

The API is unchanged and has no awareness of retry/DLQ topology --
retry/failure handling is entirely a worker-internal concern, preserving
the separation of concerns established in Phase 2.

See message-flow.md and failure-handling.md for full topology and
ACK/NACK details.


## Phase 5 -- Atomic Job Claiming (Concurrency Safety)

The worker no longer uses a SELECT-then-UPDATE pattern to begin
processing. A single atomic conditional UPDATE (claimJob) is now the
sole gatekeeper: it both decides whether a job is claimable and
performs the state transition, in one SQL statement, relying on
Postgres row-level locking to guarantee at most one caller can win a
race for the same row.

claimJob's WHERE clause allows claiming a job in QUEUED or RETRYING
status (normal/retry entry points), and additionally allows reclaiming
a job stuck in PROCESSING if it has been in that state longer than
STALE_PROCESSING_THRESHOLD_SECONDS (60s) -- treating it as orphaned
(worker likely crashed) rather than actively held. Without this, a
worker crash between claim and terminal write would permanently orphan
the job, since ordinary redelivery would otherwise never match a
PROCESSING-only exclusion.

Verified under a genuine two-process concurrent race (see
development-log.md, Phase 5 Test 4): both workers' claim attempts
landed within 1ms of each other; the losing claim's rejection reason
(currentStatus=PROCESSING, not a stale terminal state) directly
evidenced real contention at the database layer, not a sequential
near-miss.

See database.md, engineering-decisions.md, and failure-handling.md for
full detail.