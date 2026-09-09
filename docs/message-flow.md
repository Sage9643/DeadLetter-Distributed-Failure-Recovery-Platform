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