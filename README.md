# DeadLetter
## Distributed Failure Recovery Platform

[![CI](https://github.com/Sage9643/DeadLetter-Distributed-Failure-Recovery-Platform/actions/workflows/ci.yml/badge.svg)](https://github.com/Sage9643/DeadLetter-Distributed-Failure-Recovery-Platform/actions/workflows/ci.yml)

Distributed jobs fail after partial progress, brokers and databases go down mid-flight, messages get redelivered, and workers crash while holding work. Simply retrying isn't enough — a system also has to know *when* to stop retrying, *where* to put work it can no longer process automatically, and how to recover that work safely once the underlying problem is fixed.

DeadLetter is a production-oriented failure recovery platform built to demonstrate reliable asynchronous processing: retries with backoff, dead-lettering, safe replay, duplicate-delivery protection, failure classification, connection resilience, and operational observability — implemented, tested, and verified against real infrastructure rather than described in the abstract.

---

## Why DeadLetter?

Any system that hands work to a message queue and a pool of workers has to answer the same set of distributed-systems questions honestly: what happens when a worker dies mid-job, when the database or broker is briefly unreachable, when the same message is delivered twice, or when a job simply cannot succeed no matter how many times it's retried. DeadLetter exists to work through those questions with real, reproducible failures rather than leaving them as caveats.

Failure cases actually implemented and exercised against real infrastructure:

- Worker process failure mid-job (stale-claim reclaim)
- PostgreSQL outages (pool-level resilience, worker backoff)
- RabbitMQ outages (connection/channel recovery, consumer resubscription)
- Transient infrastructure errors (DB/broker errors classified separately from business failures)
- Business/non-retryable failures (immediate dead-lettering)
- Duplicate and concurrent message processing (atomic claim under real concurrent races)
- Retry exhaustion (exponential backoff to a capped ceiling, then dead-lettered)
- Dead-lettered jobs (terminal state, inspectable, historical DLQ record preserved)
- Safe replay (operator-triggered, race-safe re-queue of a dead-lettered job)

State management matters here because PostgreSQL — not RabbitMQ — is the single source of truth for a job's status. RabbitMQ is a delivery mechanism, not a system of record: a message existing or not existing in a queue is never treated as authoritative. Acknowledgement ordering matters for the same reason — a worker only ACKs a message after the corresponding database write durably lands, so a crash between "processed" and "recorded" results in redelivery, not silent loss.

---

## Architecture

```mermaid
flowchart TB
    Browser["Browser"]

    Browser -->|"HTTP"| Nginx["nginx (dashboard container)<br/>single public entry point"]
    Browser -.->|"WebSocket /ws<br/>job.updated notifications"| Nginx

    Nginx -->|"/api/*"| API["Express API"]
    Nginx -.->|"/ws"| API

    API -->|"read / write"| PG[("PostgreSQL<br/>source of truth")]
    API -->|"same transaction as the job write"| Outbox["outbox_events table"]
    Outbox -->|"dispatcher polls every 2s<br/>SKIP LOCKED claim"| MQ{{"RabbitMQ<br/>deadletter.jobs.exchange"}}

    MQ -->|"competing consumers<br/>prefetch(1)"| Worker["Worker Pool"]
    Worker -->|"atomic claim: UPDATE ... RETURNING"| PG
    Worker -->|"retryable failure: TTL + DLX requeue"| MQ
    Worker -->|"exhausted or non-retryable"| DLQ[["deadletter.jobs.dlq"]]

    PG -->|"2s change poll"| Poller["changePoller"]
    Poller -->|"job.updated broadcast"| API

    API -.->|"replay: DEAD_LETTERED to QUEUED<br/>POST /api/jobs/:id/replay"| PG
```

This mirrors the real production Compose topology (`infra/docker-compose.prod.yml`): the dashboard's nginx is the *only* container with a published host port. It serves the built SPA and reverse-proxies both `/api` and `/ws` to the API service by Docker network name. PostgreSQL and RabbitMQ (including its management UI) publish no host ports at all — reachable only from `api`/`worker` on the internal Docker network.

The WebSocket path is real, not aspirational: the API runs an internal PostgreSQL poller (`apps/api/src/ws/changePoller.ts`, 2-second interval) that broadcasts a `job.updated` notification for every row whose `updated_at` has advanced. The dashboard treats these purely as "something changed, refetch" signals over REST — never as authoritative data — so a dropped WebSocket connection never leaves it permanently wrong, only briefly stale.

---

## Core Features

- Asynchronous job submission (`POST /api/jobs`) decoupled from processing via RabbitMQ
- PostgreSQL-backed job lifecycle with a `CHECK`-constrained status column
- Competing consumers with `channel.prefetch(1)` and manual acknowledgement
- Atomic job claiming — a single conditional `UPDATE ... RETURNING`, no SELECT-then-UPDATE race window
- Stale-processing reclaim (an orphaned claim past 60s is treated as claimable again)
- Transactional outbox — job/replay writes and their "needs publishing" record commit in one PostgreSQL transaction
- Exponential retry backoff via RabbitMQ TTL + dead-letter-exchange (native RabbitMQ mechanism, no plugin)
- Maximum-attempt enforcement and explicit non-retryable failure classification
- Dead-letter queue with a permanent, inspectable historical record
- Safe, race-proof dead-letter replay (`POST /api/jobs/:id/replay`)
- Replay counters and lifetime attempt aggregates on every job
- Idempotency/concurrency protection at the database layer (`SKIP LOCKED`, atomic conditional updates)
- RabbitMQ connection recovery (event-driven cache invalidation, capped backoff resubscription)
- PostgreSQL connection resilience (no process crash on a transient pool error)
- Worker DB-error backoff (capped exponential, throttles redelivery during a sustained outage)
- API rate limiting (per-client token bucket)
- Backpressure / overload responses (`503` when the outbox backlog crosses a threshold)
- API-key authentication on state-changing routes
- CORS allowlist (no wildcard)
- Request body size limits
- Centralized error handling (no stack traces/SQL leaked to clients)
- WebSocket live dashboard updates (notification-only, REST remains authoritative)
- Docker production topology (multi-stage builds, internal-only network for Postgres/RabbitMQ)
- Idempotent migration runner with a `schema_migrations` ledger
- Liveness and readiness endpoints, deliberately distinct

---

## Job Lifecycle

```text
QUEUED ──▶ PROCESSING ──▶ COMPLETED

PROCESSING ──▶ RETRYING ──▶ PROCESSING   (via RabbitMQ TTL + DLX requeue)

RETRYING ──▶ DEAD_LETTERED               (attempts exhausted, or non-retryable)

DEAD_LETTERED ──▶ QUEUED                 (explicit operator replay)
```

`FAILED` remains a valid, `CHECK`-constrained status but is no longer written by current worker code — it is retained only for early historical rows.

Each job tracks a current-cycle `attempt_count` against a fixed `max_attempts` ceiling (default 5), plus lifetime aggregates (`total_attempt_count`, `replay_count`) and metadata from its most recent dead-letter event — preserved even after a later successful replay, so the fact a job once exhausted its retries is never lost. There is deliberately no `job_attempts` table: those aggregates are lifetime counters, not a per-attempt history with individual timestamps or errors — a documented scope decision, not an oversight (full field-by-field semantics are in `docs/database.md`).

---

## Failure Handling

Every failure a worker encounters is classified into one of four buckets, and each is handled differently:

| Class | Example | Handling |
|---|---|---|
| Transient infrastructure failure | DB unreachable while claiming, or while recording the outcome | `NACK` + requeue, with a local capped exponential backoff (1s base, doubling, capped at 30s) before the NACK, so a sustained outage throttles redelivery instead of hot-looping |
| Retryable business failure | Processor throws a plain `Error`, attempts remain | `markRetrying`, republished to the retry queue with a backoff TTL, then ACKed |
| Non-retryable business failure | Processor throws `NonRetryableError` | `markDeadLettered` immediately, published to the DLQ, then ACKed — regardless of attempts remaining |
| Retry exhaustion | `attempt_count >= max_attempts` | `markDeadLettered`, published to the DLQ, then ACKed |

**ACK/NACK ordering is deliberate.** The worker never acknowledges a message before the corresponding durable state change lands in PostgreSQL. If `processJob()` succeeds but the *bookkeeping write* (`markCompleted`) itself fails — for example because a concurrent stale-claim reclaim already moved the job elsewhere — that failure is **not** misclassified as a processing failure; it is treated as the same class of infrastructure failure as a claim error, and the message is backed off and requeued rather than incorrectly dead-lettered.

**Exponential backoff** (`apps/worker/src/retry/retryPolicy.ts`):

```text
delayMs = min(2000 * 2^(attemptCount - 1), 20000)
```

| Attempt at failure | Retry delay |
|---|---|
| 1 | 2s |
| 2 | 4s |
| 3 | 8s |
| 4 | 16s |
| 5 (default `max_attempts`) | none — dead-lettered |

The delay is implemented as a per-message RabbitMQ `expiration` property on a dedicated retry queue with no queue-level TTL. When a message's individual TTL expires, RabbitMQ's own dead-letter-exchange mechanism republishes it into the main processing queue — the delay-then-redeliver behavior is native RabbitMQ, not custom scheduling code.

---

## Transactional Outbox

Writing a job to PostgreSQL and publishing it to RabbitMQ are two separate systems with no shared transaction — a classic dual-write problem. If the DB write succeeds and the publish fails (or the process crashes between the two), the job silently never gets processed. This was reproduced for real early in the project (see `docs/incidents-and-failures.md`) on both the job-creation and replay paths.

The fix is a transactional outbox:

- `createJob` and `claimReplay` insert a row into `outbox_events` **inside the same PostgreSQL transaction** as the job write itself (via a shared `withTransaction` helper). The job's existence and its "still needs to be published" record can never diverge.
- A background dispatcher (`apps/api/src/outbox/dispatcher.ts`) polls every 2 seconds, claims a batch of pending rows with `UPDATE ... FOR UPDATE SKIP LOCKED` (so multiple dispatcher instances could run without double-claiming), and publishes each via the same, unmodified `publishJobCreated()` used everywhere else.
- A claimed row that is never marked published within 30 seconds (dispatcher crash) is treated as orphaned and reclaimed — the same pattern the worker itself uses for stale `PROCESSING` jobs.

**Explicitly not exactly-once.** If the RabbitMQ publish succeeds but the process crashes before `markOutboxPublished` commits, the row is later reclaimed as stale and published again — a genuine duplicate message. This was deliberately reproduced in a controlled test (`apps/api/src/__tests__/integration/dispatcher.test.ts`), not just theorized. Duplicate-delivery *protection* remains entirely the worker's responsibility via its atomic claim, unaffected by the outbox — the two mechanisms operate at different layers (publication vs. consumption).

**When RabbitMQ is unavailable**, outbox rows simply accumulate as pending in PostgreSQL — nothing is lost. `pendingOutboxEvents` (exposed via `GET /api/stats`) is the operational signal for this: a small transient count is normal, a sustained or growing one means the dispatcher cannot currently reach RabbitMQ. Past a configurable threshold (`BACKPRESSURE_THRESHOLD`, default 50), new `POST /api/jobs` requests are rejected with `503` rather than growing the backlog unboundedly — see Resilience below.

---

## Concurrency & Idempotency

Both the worker's job claim and the API's replay claim use the same pattern: **a single conditional `UPDATE ... WHERE ... RETURNING *`**, with the eligibility check in the `WHERE` clause — never a preliminary `SELECT` followed by a separate `UPDATE`. PostgreSQL's row-level locking guarantees that when two callers race for the same row, exactly one receives it back; the other matches zero rows against the now-already-updated state. This is what makes competing consumers safe: RabbitMQ only guarantees *at-least-once* delivery, never exactly-once, so duplicate and concurrent deliveries of the same message are expected, not exceptional — the atomic claim is the sole mechanism that turns "at least one worker will try this" into "at most one worker will actually process this at a time," proven under a genuine concurrent race (`Promise.all` against a real PostgreSQL connection in the Jest suite, and, earlier in the project's history, real multi-process manual races). The exact claim query and the rationale for database-level atomicity over an application-level or distributed lock are in `docs/database.md` and `docs/engineering-decisions.md`.

**Stale-processing reclaim** exists for the case where a worker crashes *after* claiming a job but *before* reaching a terminal state: a job stuck in `PROCESSING` for longer than 60 seconds is treated as orphaned and becomes claimable again by the same `WHERE` clause — without this, a crashed worker would permanently orphan the job.

**What this does *not* prove:** the atomic claim guarantees at most one worker *wins the database claim*; it says nothing about whether the job's actual processing logic is itself idempotent (e.g., a real side effect like sending an email). That remains the responsibility of individual job processors and is documented as a known, explicit boundary rather than an implied guarantee.

---

## Resilience

### RabbitMQ

Both the API and worker cache a single connection/channel pair and listen for `error`/`close` events, which null the cache so the next call reconnects. A worker resubscribing after a drop is the harder case, since its `channel.consume()` subscription dies with the channel:

- **API side:** no explicit reconnect loop needed — publishing only ever happens from the outbox dispatcher's own 2-second poll, so the next scheduled call reconnects naturally once the cache is null.
- **Worker side:** actively resubscribes on disconnect via a capped exponential backoff (1s, doubling, capped at 30s), guarded against overlapping triggers.

Verified against a real, deliberately induced RabbitMQ outage on the development stack (Phase 14) and again against the full production Compose topology (`verify-chaos.js`, Phase 17) — both the dispatcher and the worker's consumer resubscribed automatically, confirmed in the worker's own logs (`"Worker RabbitMQ consumer resubscribed after disconnect"`), with neither process restarted.

### PostgreSQL

A `pg.Pool`'s background `error` event (an idle client hitting a transient network/DB blip) previously called `process.exit(1)` in both the API and worker — meaning a brief Postgres hiccup took down the entire process in an environment with no process supervisor to restart it. This now only logs; the pool discards the errored client internally and lazily reconnects on the next query, exactly as `pg` is designed to.

Separately, the worker's own **foreground** DB-error paths (a failed claim, or a failed retry/dead-letter bookkeeping write) apply a local, capped exponential backoff (1s → 2s → 4s → 8s → 16s → 30s, capped) before `NACK`-ing and requeueing — throttling redelivery during a sustained outage instead of retrying as fast as RabbitMQ allows.

Verified against a real, sustained PostgreSQL outage on the development stack: the worker's backoff was observed progressing through the full capped sequence without the process being restarted, and the throttled job completed successfully once PostgreSQL recovered.

### API

- **Rate limiting:** an in-memory, per-client token bucket (100 requests / 60s by default), applied only to the two mutating routes.
- **Backpressure:** `POST /api/jobs` returns `503` when `pendingOutboxEvents` exceeds a configurable threshold (default 50) — a fresh check on every request, not cached, and deliberately *not* applied to replay (draining an existing backlog shouldn't be gated behind that same backlog).
- **Readiness:** `GET /api/health/ready` performs a real `SELECT 1` and a real RabbitMQ `checkQueue()`, distinct from liveness (`GET /api/health`, "is the process itself running").

No claim of zero downtime or high availability is made anywhere — this is a single-instance, single-host deployment shape by design (see Known Limitations).

---

## Dashboard

A React + Vite single-page app consuming the REST API and the `/ws` notification channel:

- **Overview** — total jobs, total replays, total attempts, and pending outbox events as stat cards, plus a per-status distribution (`QUEUED`/`PROCESSING`/`RETRYING`/`COMPLETED`/`DEAD_LETTERED`/`FAILED`).
- **Job list** — the 20 most recently active jobs, click-through to detail.
- **Job detail** — full job fields, lifetime aggregate counters (`total_attempt_count`, `replay_count`), dead-letter metadata when present, and a **Replay** action for `DEAD_LETTERED` jobs only.
- **Live updates** — a WebSocket connection surfaces a `Live` / `Connecting…` / `Offline (REST fallback active)` indicator in the header. Every `job.updated` event triggers a REST refetch (the event payload itself is never trusted as authoritative), and an independent 15-second periodic REST refresh runs regardless of WebSocket state. Reconnection uses exponential backoff (1s → 15s capped).
- **Authentication behavior** — read-only views need no key. Replay is a state-changing, operator-only action: on first use the dashboard prompts for the operator API key, holds it only in that browser tab's `sessionStorage` (never in the built JS bundle), and a `401` response clears the stored key and asks the operator to re-enter it.

---

## Security

- **Authentication:** a single shared `API_KEY`, checked via exact match against the `x-api-key` header, gating only the two state-changing routes (`POST /api/jobs`, `POST /api/jobs/:id/replay`). Every `GET` route and the WebSocket stay public and unauthenticated by design — this is a publicly-viewable portfolio system, and gating reads behind the same secret used for mutations would force that secret into the browser bundle. In development/test, an unset `API_KEY` is a deliberate no-op; in production, the API refuses to start without it.
- **CORS:** an explicit origin allowlist (`CORS_ALLOWED_ORIGINS`), never a wildcard, required in production.
- **Request limits:** `zod`-validated input on every mutating route and UUID-validated `:id` params before any query runs; an explicit, configurable JSON body size limit (default `100kb`).
- **Centralized error handling:** a 4-argument Express error handler registered last, so an unhandled exception never leaks a stack trace, SQL detail, or file path to the client in production — the full error is always logged server-side.
- **Reverse-proxy trust:** `app.set("trust proxy", 1)` — trusts exactly one hop (nginx), not an unbounded chain. This is safe specifically because the API has no published host port of its own in the production topology; nginx is the only thing that can ever be that one trusted hop. Covered by a dedicated unit test (`apps/api/src/__tests__/unit/trustProxy.test.ts`).
- **Secrets:** never committed, never baked into a Docker image or the dashboard's JS bundle. `infra/docker-compose.prod.yml` reads every credential via Compose's `${VAR:?required}` interpolation, which fails loudly (not silently) if a value is missing.
- **Network exposure:** in production, only the dashboard's nginx container publishes a host port. PostgreSQL and RabbitMQ (including its management UI) publish none — reachable only on the internal Docker network.
- Public deployment should terminate real TLS in front of the dashboard's published port (see Production Deployment) — no certificate has been issued yet, since no public host exists yet.

Full detail, including a real `npm audit` breakdown (0 vulnerabilities in the 122 production dependencies that actually ship; 5 dev-tooling-only findings in the dashboard's build toolchain, assessed and deliberately not force-upgraded), is in `docs/security.md`.

---

## Tech Stack

| Layer | Technology |
|---|---|
| API | Node.js / Express / TypeScript |
| Worker | Node.js / TypeScript |
| Frontend | React / Vite |
| Database | PostgreSQL |
| Messaging | RabbitMQ |
| Containers | Docker / Docker Compose |
| Testing | Jest / Vitest / Supertest / node:test / k6 |
| CI | GitHub Actions |

---

## Repository Structure

```text
apps/
  api/          Express API — routes, services, outbox, WebSocket broadcaster, migration runner
  worker/       RabbitMQ consumer — claim, retry/backoff, dead-lettering
  dashboard/    React + Vite operational dashboard

infra/
  docker-compose.yml        local development (Postgres + RabbitMQ only)
  docker-compose.prod.yml   full production topology (migrate, api, worker, dashboard, postgres, rabbitmq)
  migrations/                plain, additive SQL, applied by apps/api/src/scripts/migrate.ts

docs/          architecture, API, database, deployment, testing, security, and engineering-decision records

tests/
  load/k6/      k6 load and chaos scenarios, run manually against real infrastructure
  integration/  cross-process concurrency scripts (e.g. concurrent-replay)
```

`packages/shared` exists as an npm workspace but is currently unused — each app still owns a small duplicated test-helper file rather than a shared package, a deliberate choice not to introduce cross-workspace coupling before there's a second real consumer of shared code.

---

## API

All endpoints are relative to `/api`. See `docs/api.md` for full request/response shapes.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | none | Liveness — is the process running? |
| `GET` | `/health/ready` | none | Readiness — are PostgreSQL and RabbitMQ both currently reachable? `503` if either is down. |
| `POST` | `/jobs` | `x-api-key` | Submit a new job. Rate-limited and backpressure-gated. |
| `GET` | `/jobs` | none | 20 most recently active jobs. |
| `GET` | `/jobs/:id` | none | Full job detail by id. |
| `POST` | `/jobs/:id/replay` | `x-api-key` | Re-queue a `DEAD_LETTERED` job. Rate-limited, **not** backpressure-gated. |
| `GET` | `/stats` | none | Aggregate operational stats, including `pendingOutboxEvents`. |
| `WS` | `/ws` | none | `job.updated` push notifications (notification-only, never authoritative). |

---

## Local Development

**Prerequisites:** Node.js 22, Docker Desktop (for PostgreSQL/RabbitMQ), npm.

Shell note: examples below use POSIX-style shell syntax. On Windows PowerShell/cmd, use the equivalent environment-variable syntax for your shell.

```bash
# 1. Install dependencies (npm workspaces — installs all three apps)
npm ci

# 2. Copy env templates and fill in local values
cp apps/api/.env.example apps/api/.env
cp apps/worker/.env.example apps/worker/.env
# apps/api/.env and apps/worker/.env should point DATABASE_URL/RABBITMQ_URL
# at the credentials in infra/docker-compose.yml (deadletter / deadletter_dev_password).

# 3. Start local infrastructure (Postgres 16 + RabbitMQ 3.13-management)
cd infra && docker compose up -d && cd ..

# 4. Apply migrations against the dev database
npm run migrate -w apps/api

# 5. Run each app in its own terminal
npm run dev -w apps/api         # http://localhost:3000
npm run dev -w apps/worker
npm run dev -w apps/dashboard   # http://localhost:5173 (proxies /api and /ws to :3000)
```

**Test database** (needed to run the API/worker Jest suites — a second logical database in the same container):

```bash
docker exec -it deadletter-postgres psql -U deadletter -d deadletter -c "CREATE DATABASE deadletter_test;"
cd apps/api
DATABASE_URL=postgresql://deadletter:deadletter_dev_password@localhost:5432/deadletter_test \
MIGRATIONS_DIR=../../infra/migrations \
npm run migrate
```

**Running tests:**

```bash
npm test -w apps/api          # Jest + ts-jest, real PostgreSQL/RabbitMQ
npm test -w apps/worker       # Jest + ts-jest, real PostgreSQL
npm test -w apps/dashboard    # Vitest + Testing Library
node --test 'apps/api/scripts/__tests__/*.test.js'   # node:test, standalone-script regression tests
```

This is deliberately a separate, local-dev-only Compose file (`infra/docker-compose.yml`) from the production topology below — introducing the production file never risked breaking this workflow.

---

## Production Deployment

```text
Internet
   │
   ▼
TLS reverse proxy / ingress   (external to this repo — see below)
   │
   ▼ (only published port on the host)
dashboard (nginx, static build) ──/api, /ws──▶ api (Express + ws)
                                                   │
                                        ┌──────────┴──────────┐
                                        ▼                     ▼
                                   postgres               rabbitmq
                              (no published port)    (no published port,
                                                      management UI not exposed)
                                        ▲
                                        │
                                     worker
```

`infra/docker-compose.prod.yml` runs `migrate` (one-shot, applies pending migrations and exits), `postgres`, `rabbitmq`, `api`, `worker`, and `dashboard` as Docker Compose services on a single host. `api` and `worker` both depend on `migrate` completing successfully and on `postgres`/`rabbitmq` reporting healthy before they start. `dashboard` is the **only** Compose service with a published host port.

TLS termination is an external, deployment-layer responsibility — a reverse proxy or ingress (Caddy, nginx, a managed load balancer, a platform's built-in TLS, etc.) placed in front of this stack — and is **not** currently part of `infra/docker-compose.prod.yml`. No such proxy has actually been deployed as part of this repository; see `docs/deployment.md` for the target architecture and remaining steps.

```bash
cd infra
# Fill in infra/.env.production from infra/.env.production.example first.
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f migrate api worker dashboard
```

Every secret (`API_KEY`, database/broker credentials, `CORS_ALLOWED_ORIGINS`) is required via Compose's `${VAR:?required}` syntax — the stack refuses to start with any of them unset, rather than silently running with a default.

**This topology has been run for real** — all containers healthy, nginx correctly proxying `/api` and `/ws`, `401` on an unauthenticated mutating request, a real job completing end-to-end (API → Postgres/outbox → RabbitMQ → worker → Postgres) — **on the project owner's own Docker Desktop environment. It has not yet been deployed to a public host.** Reaching a real, public URL still requires a VPS/domain the project owner controls and a decision about deployment access, none of which can be supplied from this environment — see `docs/deployment.md` for the exact remaining steps.

---

## Testing & Verification

Real, currently-verified results (no invented numbers — see `docs/testing.md` and `docs/development-log.md` for the full history and how each figure was produced):

| Suite | Result |
|---|---|
| API (Jest + ts-jest + Supertest, real PostgreSQL/RabbitMQ) | 21/21 suites, 97/97 tests passed |
| Worker (Jest + ts-jest, real PostgreSQL) | 8/8 suites, 28/28 tests passed |
| Dashboard (Vitest + Testing Library) | 13/13 tests passed |
| Dashboard production build (`tsc -b && vite build`) | successful |
| Script regression tests (`node:test`, `verify-*.js` helper functions) | 7/7 passed |

**Verification scripts** (`apps/api/scripts/`), run for real by the project owner against the full production Compose topology:

- `verify-ws.js` — a job created through the public `/api/jobs` endpoint produced a real `job.updated` (`COMPLETED`) event over `/ws`, through nginx.
- `verify-chaos.js` — both a PostgreSQL outage and a RabbitMQ outage were genuinely induced: liveness stayed up throughout, readiness correctly reported each failure, both services recovered, and real jobs completed after recovery. The worker's own logs confirmed automatic RabbitMQ resubscription with no manual restart.
- `verify-latency.js` — through the public nginx origin, 50 requests per path: liveness p50 14.7ms / p95 23.7ms / p99 95.1ms; readiness p50 15.0ms / p95 19.1ms / p99 22.8ms; authenticated job creation p50 15.4ms / p95 27.2ms / p99 34.2ms. These describe this one local Docker Desktop environment, not a production host or network path, and are the first measurements taken with this script — there is no prior baseline to compare against.

**Load and chaos testing** (`tests/load/k6/`, run manually against real Docker Compose infrastructure — see `docs/load-testing.md`): six k6 scenarios covering normal submission, concurrent submission, retryable-failure/DLQ exhaustion, outbox backlog during a RabbitMQ outage, replay under concurrency, and rate-limit/backpressure behavior. Headline real result: Scenario B (10 VUs, 20s, two competing workers) submitted 4,813 jobs with 100% success; verified directly against PostgreSQL, all 4,813 reached `COMPLETED` with zero jobs claimed more than once.

**Migration runner:** verified idempotent for real — a temporary no-op migration added to an already-initialized database was applied once, then correctly skipped on re-run.

---

## Engineering Decisions

Full rationale for every decision below lives in `docs/engineering-decisions.md`; a few of the more consequential ones:

- **PostgreSQL as the durable source of truth** — RabbitMQ is a delivery mechanism only; job state is never inferred from queue contents.
- **RabbitMQ for asynchronous delivery** — competing consumers, native TTL + dead-letter-exchange for delayed retry, no third-party delay plugin.
- **Transactional outbox** over a reconciliation-only approach — closes the DB/broker dual-write gap at write time rather than detecting and repairing it after the fact.
- **Atomic conditional claim** (`UPDATE ... WHERE ... RETURNING`) over SELECT-then-UPDATE — correctness enforced by PostgreSQL's own row locking, not application-level coordination.
- **Manual ACK, after the durable write** — a message is never acknowledged until its outcome is safely recorded.
- **DLX/TTL retry strategy** instead of a delayed-message plugin — the delay mechanism is native RabbitMQ behavior.
- **Replay semantics** — resets the per-cycle `attempt_count` but preserves lifetime aggregates and dead-letter history indefinitely; deliberately does not remove the original DLQ message (PostgreSQL alone is authoritative for whether a job is resolved).
- **Connection recovery via event-listener invalidation**, not periodic liveness polling — reacts to an actual disconnect immediately rather than on the next poll tick.
- **API rate limiting and backpressure as two separate concerns** — an in-memory, route-agnostic token bucket versus a DeadLetter-specific outbox-backlog check — rather than one combined middleware.

---

## Known Limitations

Honestly documented, not hidden:

- **No backup/restore procedure** for the production PostgreSQL volume — a real, named gap for an actual production deployment.
- **No container resource limits** in `infra/docker-compose.prod.yml` — every service can consume unbounded host CPU/memory; found during the final security audit, not yet fixed.
- **Single-instance rate limiting** — the token bucket is an in-memory `Map`, reset on every API restart, with no cross-instance coordination if the API is ever horizontally scaled.
- **Single shared operator API key** — no per-user accounts, roles, or session model. A deliberate scope decision for a single-operator system, not an oversight, but a real constraint if that assumption ever changes.
- **Forward-only migrations** — no automated down-migration; a schema rollback would be a manual, deliberate `psql` operation.
- **No per-attempt history table** — `total_attempt_count`/`replay_count` are lifetime aggregates only, not individual timestamped attempt records.
- **Outbox durability, not exactly-once delivery** — a genuine duplicate publish after a dispatcher crash is a real, reproduced, accepted scenario; duplicate *processing* is separately prevented at the worker's claim layer.
- **Not yet deployed to a public host** — validated locally against Docker Desktop; a real deployment still needs a VPS, a domain, and TLS termination.
- **Dev-tooling dependency findings** — 5 `npm audit` findings, all in the dashboard's build/test toolchain (vite/vitest/esbuild), none reachable in this project's actual usage, deliberately not force-upgraded (each fix is a semver-major bump deserving its own upgrade pass).
- **WebSocket updates are near-real-time, not instant** — bounded by a 2-second poll interval; a job passing through multiple states within one interval is only broadcast at its final state.

---

## Quick Demo

What happens when a job fails, exhausts its retries, and is recovered:

1. Client submits a job — `POST /api/jobs`.
2. The API persists it to PostgreSQL as `QUEUED`.
3. In the same transaction, an outbox event is recorded; the dispatcher publishes it to RabbitMQ within 2 seconds.
4. A worker claims it atomically, moving it to `PROCESSING`.
5. Processing fails with a retryable error.
6. The worker schedules a retry with exponential backoff (RabbitMQ TTL + DLX) and marks the job `RETRYING`.
7. This repeats until `attempt_count` reaches `max_attempts`.
8. The job is marked `DEAD_LETTERED` and published to the dead-letter queue.
9. An operator inspects it in the dashboard — full detail, last error, dead-letter metadata.
10. The operator clicks **Replay** (entering the operator API key once per browser tab).
11. The job is atomically moved back to `QUEUED`, with `attempt_count` reset and `replay_count` incremented.
12. A worker claims and processes it again through the identical lifecycle — indistinguishable, to the worker, from a first-time job.

---

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — full system design, phase-by-phase
- [`docs/api.md`](docs/api.md) — complete endpoint reference
- [`docs/database.md`](docs/database.md) — schema and migration history
- [`docs/message-flow.md`](docs/message-flow.md) — RabbitMQ topology and message contracts
- [`docs/failure-handling.md`](docs/failure-handling.md) — retry policy, ACK/NACK rules, replay semantics
- [`docs/security.md`](docs/security.md) — full security baseline and audit findings
- [`docs/observability.md`](docs/observability.md) — metrics, logging, and what is deliberately not measured
- [`docs/testing.md`](docs/testing.md) — test strategy, structure, and real execution results
- [`docs/load-testing.md`](docs/load-testing.md) — k6 scenarios and real chaos-test results
- [`docs/deployment.md`](docs/deployment.md) — production topology, migration procedure, deployment status
- [`docs/engineering-decisions.md`](docs/engineering-decisions.md) — the full decision log with rationale
- [`docs/incidents-and-failures.md`](docs/incidents-and-failures.md) — every real incident: reproduction, root cause, fix, verification
- [`docs/development-log.md`](docs/development-log.md) — the complete phase-by-phase development history
