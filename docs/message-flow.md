# Message Flow

## Topology

- **Exchange:** `deadletter.jobs.exchange` (type: `direct`, durable)
- **Queue:** `deadletter.jobs.queue` (durable)
- **Routing key:** `job.created`
- **Binding:** `deadletter.jobs.queue` bound to `deadletter.jobs.exchange` with routing key `job.created`

## Why a direct exchange

We currently have exactly one message type (a job was created) going to
exactly one queue. A direct exchange (exact routing-key match) models
this honestly without introducing pattern-matching flexibility (topic
exchange) we don't yet need. Revisit if/when genuinely different message
types requiring different routing are introduced.

## Why the message body will be thin (jobId only)

PostgreSQL is the source of truth for job state (see architecture.md).
Putting the full job payload in the message would create a second copy
of the truth that can drift from the database. The worker will always
re-fetch current state from Postgres using the jobId before acting.

## Topology declaration

Both the API and worker independently declare this topology on connect
via `assertExchange`/`assertQueue`/`bindQueue`. These calls are
idempotent — safe to run every time a process starts, regardless of
which process (API or worker) connects first. No separate migration
step is needed, unlike the SQL schema.

## Verified (Phase 2, connection step)

- API successfully connects to RabbitMQ using `amqplib`
- Exchange, queue, and binding confirmed to exist via the RabbitMQ
  management UI (not just assumed from code running without error):
  exchange type `direct`/durable, queue type `classic`/durable, binding
  present with correct routing key


## Verified (Phase 2, consumer step)

- Worker successfully connects independently, confirms existing
  topology (idempotent declaration from a second process)
- `channel.prefetch(1)` set — worker receives at most 1 unacknowledged
  message at a time
- Manual ACK mode (`noAck: false`) — worker explicitly acknowledges
  each message after processing
- Full pipeline proven end-to-end: two real messages (one from an
  isolated manual publish, one from an actual `POST /api/jobs` HTTP
  request) both sat in the queue with 0 consumers, then were both
  correctly received, parsed, and acknowledged the instant the worker
  connected — confirmed via worker logs (jobId matched exactly) and
  RabbitMQ UI (Ready/Unacked both dropped to 0)

## Not yet handled (deliberately deferred)

- Worker does not yet update job status in Postgres (still QUEUED
  forever from the DB's perspective) — Phase 3
- No retry/NACK logic — worker always ACKs unconditionally — Phase 4
- No idempotency protection against duplicate delivery — Phase 5
- DB write succeeding while RabbitMQ publish fails — not yet
  deliberately reproduced (next planned test)


## Verified — Competing Consumers (Phase 2)

Ran two independent worker processes simultaneously, both connected to
`deadletter.jobs.queue`. Confirmed via RabbitMQ management UI:
Consumers: 2.

Created 4 jobs in quick succession via `POST /api/jobs`. Observed
distribution:

| Job (creation order) | Consumed by |
|----------------------|-------------|
| 1st                  | Worker #1   |
| 2nd                  | Worker #2   |
| 3rd                  | Worker #1   |
| 4th                  | Worker #2   |

Clean alternation — RabbitMQ's default round-robin-style distribution
across competing consumers, each with `prefetch(1)`. This confirms the
"Worker 1, Worker 2, Worker N" scaling model from the original
architecture works with zero code changes — running more worker
processes is the entire scaling mechanism, no code awareness of "how
many workers exist" is needed anywhere.


## Phase 3 update -- ACK/NACK strategy

- Message ACKed only after the job's terminal DB status is successfully
  written -- not on receipt.
- DB error while fetching/marking PROCESSING (infra failure) -> NACK with
  requeue=true. No backoff yet (Phase 4 concern).
- processJob() throwing (business-logic failure) -> recorded as FAILED,
  then ACKed -- not requeued, since no retry policy exists yet.
- Malformed messages / unknown job ids -> ACKed and discarded.
- Lightweight terminal-state guard (skip if already COMPLETED/FAILED)
  prevents redundant reprocessing on redelivery -- NOT full idempotency,
  no locking against concurrent processing. See failure-handling.md.
- RabbitMQ continues to provide at-least-once delivery only. Exactly-once
  processing is never guaranteed by this system.


## Phase 4 update -- retry and dead-letter topology

New exchange: `deadletter.jobs.failures.exchange` (direct), worker-only
(API never publishes here).

- Routing key `job.retry` -> `deadletter.jobs.retry.queue`
  - Queue arguments: x-dead-letter-exchange=deadletter.jobs.exchange,
    x-dead-letter-routing-key=job.created
  - No queue-level TTL; each message carries its own `expiration`
    property (milliseconds) set at publish time based on calculated
    backoff
  - On TTL expiry, RabbitMQ automatically republishes the message to
    deadletter.jobs.exchange with routing key job.created -- this native
    dead-letter-exchange behavior is the entire retry/delay mechanism,
    no plugin or custom scheduling code required
- Routing key `job.dead_letter` -> `deadletter.jobs.dlq`
  - Terminal; not consumed this phase

RabbitMQ continues to provide at-least-once delivery only, never
exactly-once. This applies to retry-queue redelivery as well as original
delivery.


## Phase 5 update

No topology changes -- duplicate and concurrent deliveries are now
handled entirely at the PostgreSQL layer via claimJob's atomic
conditional UPDATE, not by any RabbitMQ-level mechanism. RabbitMQ
continues to provide only at-least-once delivery; deduplication and
concurrency safety are the consuming application's responsibility, now
correctly implemented and verified under a real concurrent race. See
failure-handling.md and development-log.md (Test 4).