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