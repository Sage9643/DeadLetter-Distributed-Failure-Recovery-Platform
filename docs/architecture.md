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

## Open Design Question (resolved, Phase 10)

**Consistency problem between PostgreSQL and RabbitMQ**: what happens if a
job is written to PostgreSQL successfully but the RabbitMQ publish fails
(or vice versa)? This is a classic dual-write problem. This section
originally deferred solving it until the problem was actually
reproduced. It was reproduced (see incidents-and-failures.md,
Deliberate Tests 2 and 3) on both the job-creation and replay paths,
and resolved by Phase 10's transactional outbox -- both
`POST /api/jobs` and `POST /:id/replay` now write to Postgres and
record an outbox event in the same transaction, with a separate
dispatcher publishing to RabbitMQ afterward. See "Phase 10 --
Transactional Outbox (Durable Publication)" below and
`docs/engineering-decisions.md` for the full design. Corrected during
Phase 15's documentation review -- this section was previously stale,
still describing the problem as unsolved.

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


## Phase 6 -- DLQ Inspection + Safe Replay

Added one new explicit state transition: DEAD_LETTERED -> QUEUED, via
POST /api/jobs/:id/replay only. No automatic replay exists.

Full lifecycle, as implemented and verified:

  JOB -> PROCESSING -> RETRIES -> DEAD_LETTERED -> [explicit replay]
    -> QUEUED -> PROCESSING (existing claim path, unmodified)
    -> COMPLETED or DEAD_LETTERED again

Design principle preserved: replay does NOT introduce a second
processing path. It performs exactly one atomic PostgreSQL write
(DEAD_LETTERED -> QUEUED) and publishes the existing thin {jobId}
message via the unmodified publishJobCreated() function. From that
point forward, the replayed job is indistinguishable to
apps/worker/src/consumer.ts from any other QUEUED job -- consumer.ts
was NOT modified in this phase, confirming the design stayed minimal.

Verified end-to-end (see development-log.md for full real evidence):
- Replay of a DEAD_LETTERED job with an unresolved failure condition
  correctly re-fails and re-dead-letters (jobId
  6d0addf3-921c-47f5-86bb-ca495545d415)
- Replay of a DEAD_LETTERED job with the failure condition cleared
  correctly reaches COMPLETED, with the retry/backoff machinery working
  identically to a first-time job (jobId
  03a4cfcd-72d3-4e32-925d-5bef85425ceb)
- Two concurrent replay requests for the same job: exactly one wins
  (verified via replay_count=1, not 2, plus millisecond-level claim
  timestamp overlap) (jobId 26a1f8db-6822-4563-86e0-16e2e505ed60)


## Phase 6 -- DLQ Inspection + Safe Replay (Verified)

One new explicit state transition: DEAD_LETTERED -> QUEUED, via
POST /api/jobs/:id/replay only. No automatic replay exists.

  JOB -> PROCESSING -> RETRIES -> DEAD_LETTERED -> [explicit replay]
    -> QUEUED -> PROCESSING (existing Phase 5 claim path, unmodified)
    -> COMPLETED or DEAD_LETTERED again

consumer.ts was NOT modified. Replay performs exactly one atomic
PostgreSQL write (DEAD_LETTERED -> QUEUED) and publishes the existing
thin {jobId} message via the unmodified publishJobCreated(). From that
point the replayed job is indistinguishable to the worker from any
other QUEUED job.

### Verified real evidence (see development-log.md for full detail)

- Replay of a job whose failure condition was NOT fixed correctly
  re-fails and re-dead-letters (job 6d0addf3...)
- Replay of a job whose failure condition WAS fixed correctly reaches
  COMPLETED, with Phase 4's retry/backoff logic unaffected (job
  03a4cfcd...)
- A replayed job that hits a retryable failure correctly re-runs the
  FULL independent 5-attempt backoff cycle, timing measured within
  3-7ms of calculated values (job 2c45f4f0...)
- Two concurrent replay requests for the same job: exactly one wins,
  verified via 14ms claim-timestamp overlap and replay_count=1 (job
  26a1f8db..., evidence reused from the deterministic concurrency-test
  session, not re-run during this verification pass)
- Phase 5's stale-PROCESSING reclaim mechanism re-verified working
  correctly, unaffected by Phase 6 (job 91842b6d...)

### Known limitations discovered during verification

- DB/RabbitMQ dual-write gap (tracked since Phase 0/2) reproduced for
  real on the replay path specifically -- see failure-handling.md and
  incidents-and-failures.md
- API RabbitMQ channel does not auto-recover after a broker restart --
  see incidents-and-failures.md


## Phase 8 -- Observability & Operational Visibility

Added three new API routes (stats.ts, health.ts extracted from the
former inline app.ts handler) and one new service (statsService.ts).
No schema changes, no new topology, no new infrastructure.

- GET /api/stats: PostgreSQL-only aggregate query. Never queries
  RabbitMQ -- avoids introducing a second protocol/port coupling for
  an operational-visibility endpoint.
- GET /api/health vs GET /api/health/ready: liveness (process running)
  is now explicitly distinguished from readiness (dependencies
  reachable). Readiness performs real checks against both PostgreSQL
  and RabbitMQ.
- Worker: per-attempt processing duration added to existing structured
  logs (log-level only, not persisted or aggregated). Graceful
  shutdown (SIGTERM/SIGINT) added -- the worker previously had no
  signal handling at all.

consumer.ts's claim/retry/DLQ/ACK-NACK control flow, apps/api and
apps/worker's jobService.ts files, and the replay route are all
unchanged this phase -- confirmed via git diff against the Phase 7
commit (bfceaf9), not merely assumed. See engineering-decisions.md and
development-log.md for full verification detail.


## Phase 9 -- React Operational Dashboard + Real-Time Updates

New apps/dashboard workspace (React + Vite), consuming existing REST
endpoints plus one new one (GET /api/jobs). WebSocket infrastructure
added to apps/api only -- apps/worker requires ZERO changes, confirmed
via git diff against commit 7ae6feea showing consumer.ts and worker's
jobService.ts completely absent from the diff.

### WebSocket ownership and design

The API owns the WebSocket server, attached to the SAME http.Server
Express already uses (no second port). A background poller inside the
API process (apps/api/src/ws/changePoller.ts) queries PostgreSQL every
2 seconds for jobs changed since a cursor, and broadcasts a minimal
job.updated notification for each. This deliberately avoids a
worker-to-API push design (which would require touching consumer.ts
and creating a new runtime coupling between the two processes) in favor
of the API independently watching its own source of truth.

apps/api/src/app.ts was deliberately NOT modified -- the WebSocket
server and poller are bootstrapped only in index.ts, so the 38 existing/
new API tests (which import app via supertest) are structurally
unaffected. Confirmed via git diff: app.ts shows zero changes against
7ae6feea.

See message-flow.md equivalent content in api.md and full rationale in
engineering-decisions.md.


## Phase 10 -- Transactional Outbox (Durable Publication)

Closes the DB/RabbitMQ dual-write gap reproduced with real evidence in
Phase 2 (Deliberate Test 2, stuck job 4581724a...) and Phase 6
(Deliberate Test 3, stuck job 7c305a47...).

New table: outbox_events (FK to jobs). createJob and claimReplay now
write their job change AND an outbox_events row in ONE PostgreSQL
transaction (via a new withTransaction helper). Neither function calls
publishJobCreated directly anymore -- the actual RabbitMQ publish is
performed asynchronously by a new background dispatcher
(apps/api/src/outbox/dispatcher.ts), which polls for pending outbox
rows every 2 seconds and publishes them via the EXISTING, UNCHANGED
publishJobCreated (Phase 2) -- no new message format, no new topology.

The dispatcher runs inside the same API process as Phase 9's
change-poller, started/stopped identically in index.ts. apps/worker is
completely unaffected -- consumer.ts, worker's jobService.ts, and the
RabbitMQ publisher/connection modules are all byte-identical to the
Phase 9 commit (902d194), confirmed via git diff.

**Explicit limitation, not glossed over:** the outbox guarantees
durable PUBLICATION intent (a job's need to be published survives any
crash or RabbitMQ outage), NOT exactly-once DELIVERY. See
failure-handling.md and engineering-decisions.md.

Verified real via a deliberate RabbitMQ-outage test -- see
development-log.md for the full walkthrough with real job IDs,
timestamps, and attempt counts.


## Phase 12 -- Rate Limiting & Backpressure

Two new, deliberately separate protective middleware in front of the
already-proven Phase 5/6/10 core logic. Neither changes any protected
production component (createJob, claimReplay, claimJob, withTransaction,
outboxService, dispatcher, worker, RabbitMQ topology, publisher,
migrations all confirmed byte-identical to the Phase 11 checkpoint --
see development-log.md's Phase 12 diff inspection).

**Rate limiting** (`apps/api/src/middleware/rateLimiter.ts`): a
generic, in-memory, per-client token-bucket limiter with zero knowledge
of jobs/replay/outbox/DeadLetter concepts -- reusable outside this
project unchanged. ONE shared instance protects both POST /api/jobs and
POST /api/jobs/:id/replay (one combined budget per client, not two).
GET routes are never rate-limited.

**Backpressure** (`apps/api/src/middleware/backpressure.ts`): the
opposite kind of component -- explicitly DeadLetter-specific, reading
the existing (Phase 8/10, unmodified) getStats()'s pendingOutboxEvents
field fresh on every request. Applied ONLY to POST /api/jobs; POST
/api/jobs/:id/replay is deliberately exempt (see
engineering-decisions.md).

Route order for POST /api/jobs: rate limiter -> backpressure -> the
existing, unmodified createJob() handler. For POST /api/jobs/:id/replay:
rate limiter -> the existing, unmodified claimReplay() handler. A 429
or 503 from either middleware short-circuits the request via Express's
normal middleware chain (no call to next()) -- createJob()/claimReplay()
are never reached, and no database write occurs. Verified real via
backpressure.test.ts and rateLimiterRoute.test.ts (both assert DB row
counts are unchanged across a rejection), and confirmed at k6 volume
across two real executions (28,281 real 429/503 rejections in the
first, synthetic-environment execution; 5,653 in the second,
authoritative real Windows Docker Compose execution), 0 corresponding
job rows in either -- see load-testing.md.

**Real interaction discovered with the pre-existing Incident 5
limitation:** a genuine RabbitMQ outage chaos test has now been run
twice -- once against PostgreSQL 16/RabbitMQ 3.12 installed directly in
a cloud session that could not reach Docker Hub (see
incidents-and-failures.md, Incident 8, for why), and once, later,
against the project's real, unmodified `docker-compose.yml` stack
(PostgreSQL 16, RabbitMQ 3.13-management-alpine) on Windows -- the
second, real-Docker-Compose execution is authoritative. Both real runs
showed pendingOutboxEvents genuinely climb into backpressure and a real
503 genuinely fire. **The two runs disagree on one point:** in the
first execution, once the API's cached RabbitMQ channel went stale
(Incident 5, unfixed, unmodified in this phase), the resulting backlog
did NOT self-clear even after RabbitMQ was restored, and required an
API process restart; in the second, authoritative execution, the
backlog drained on its own without an API restart. This disagreement is
real and currently unexplained -- see incidents-and-failures.md,
Incident 8, for the full record and the open question it leaves. In
both runs the worker process's own RabbitMQ connection did NOT
self-recover and needed a restart. This is a real, observed interaction
with a pre-existing limitation, not a Phase 12 defect, and per the
explicit Phase 12 scope guard no change was made to connection.ts, the
dispatcher, or any other protected component to investigate or resolve
the disagreement.

## CI/CD (Phase 13)

`.github/workflows/ci.yml` runs on every push and pull request targeting
`main`. It is split into three independent jobs -- `api`, `worker`, and
`dashboard` -- so each workspace's build/test result is visible on its
own in the Actions UI rather than as one combined pass/fail.

- **`api`** and **`worker`**: each provisions its own `postgres:16-alpine`
  and `rabbitmq:3.13-management-alpine` GitHub Actions *service*
  containers, using the exact same image tags and credentials as
  `infra/docker-compose.yml` and the exact same healthchecks. Because
  these jobs run directly on the runner VM (no `container:` key), the
  service ports are reachable at `localhost`, which is exactly what
  `apps/api/.env.test` and `apps/worker/.env.test` already expect --
  no workflow-level environment overrides were needed. Each job runs
  `npm ci` at the workspace root, builds its app (`tsc`), creates the
  `deadletter_test` database, and applies `infra/migrations/*.sql` by
  building and running `apps/api/src/scripts/migrate.ts` (Phase 17 --
  previously this piped each `infra/init-db/*.sql` file through `psql`
  by hand; CI now exercises the exact same migration runner that
  `infra/docker-compose.prod.yml`'s `migrate` service runs in
  production, so a broken migration fails CI before it could ever reach
  a real deployment), then runs `npm test -w apps/<app> --
  --runInBand`.
- **`dashboard`**: no services needed -- it runs `tsc -b && vite build`
  and `vitest run` against mocked/component-level tests only.

**Deliberately out of scope for CI, preserving the existing project
direction rather than expanding it:** k6 load tests and the manual
chaos/RabbitMQ-outage tests. `docs/load-testing.md` already documents
these as run manually, against real Docker Compose infrastructure, not
wired into any CI -- this phase does not change that. See
engineering-decisions.md for the reasoning.

**Verification status:** the individual commands in this workflow
(`npm run build -w apps/api`, `-w apps/worker`; `npx tsc -b` for the
dashboard) were run for real in this phase and passed (see
development-log.md, Phase 13). The Jest suites could not be executed
from this session's own environment for the same pre-existing bridge
limitation documented in Phase 12's closure (not a defect in this
workflow), and the dashboard's `vite build`/`vitest run` hit an
unrelated, session-local `@rollup/rollup-linux-x64-gnu` optional-
dependency gap (a well-known npm bug, not a project defect -- a fresh
`npm ci` on a real Linux GitHub Actions runner installs the correct
platform binary). The workflow file itself has not yet been exercised
by an actual GitHub Actions run, since doing so requires a push, which
this phase deliberately does not perform -- see development-log.md for
the full, honest accounting of what was and was not verified.
## RabbitMQ connection recovery (Phase 14)

Resolves Incident 5 (Phase 6) and Incident 8 (Phase 12) -- see
incidents-and-failures.md for the full incident record and the
Phase 14 update appended to Incident 8.

**Problem:** `apps/api/src/queue/connection.ts` and
`apps/worker/src/queue/connection.ts` each cached a single
connection/channel pair in a module-level variable and only ever
checked whether that variable was non-null, never whether the
underlying broker connection was actually still alive. If RabbitMQ
restarted or the connection dropped while a channel was already
cached, the stale object stayed cached indefinitely -- every
subsequent publish (API) or the entire consumer subscription (worker)
stayed broken until a manual process restart, with the two real chaos
executions in Incident 8 showing this could resolve itself or not,
unpredictably, depending on incidental amqplib event timing.

**Fix:** both connection modules now attach `'error'`/`'close'`
listeners to the connection and the channel at the moment each is
created. Either event nulls the cached references and emits an
`"invalidated"` event on a small exported `connectionEvents`
(`EventEmitter`). An identity check (comparing against the exact
connection/channel instance the listener was attached to) guards
against a stale, late-arriving event from an already-replaced
connection clobbering a newer, healthy one. A `closingIntentionally`
flag, set for the duration of an explicit `closeConnection()` call,
prevents that same intentional close from being mistaken for a
failure and triggering a reconnect.

- **API side:** no further change needed. `publishJobCreated()` is
  only ever called by the outbox dispatcher's existing 2-second poll
  loop (job creation and replay both go through the outbox since Phase
  10, not a direct synchronous publish) -- once the cache is null, the
  next scheduled `getChannel()` call reconnects naturally. The poll
  loop itself already acts as the retry mechanism; no separate backoff
  scheduler was added.
- **Worker side:** reconnecting `getChannel()` alone is not enough,
  because the consumer's `channel.consume()` subscription dies with
  the channel and nothing re-attaches it to a new one automatically.
  `apps/worker/src/consumer.ts` extracts the "attach prefetch + consume
  to whatever channel getChannel() returns" step into its own
  function, called once at startup and again, automatically, every
  time `connectionEvents` emits `"invalidated"`, via a capped
  exponential backoff loop (1s, doubling, capped at 30s) guarded
  against overlapping triggers.

**Deliberately unchanged:** the message-handling closure inside the
worker's consumer (claim/process/ack/nack, retry/DLQ routing) is
byte-for-byte the same code, only moved into its own function so both
the initial subscribe and every later resubscribe share it. No change
was made to the dispatcher's polling interval/batch size, the outbox
schema or claiming logic, or either app's public `getChannel()` /
`closeConnection()` signatures.

**Validation status:** see development-log.md's Phase 14 addendum and
the updated Phase 14 update on Incident 8 in incidents-and-failures.md
for the full, honest accounting. In short: a real TypeScript build
passed for both apps, and both real Jest suites passed on the user's
real Windows environment -- `apps/api`: 18 suites / 82 tests, `apps/worker`:
4 suites / 15 tests -- including all three new Phase 14 unit tests
(after a test-only synchronization fix to `consumerResubscribe.test.ts`
documented in the Phase 14 addendum; the recovery implementation
itself was not changed for that fix). A real RabbitMQ chaos test
against the actual Docker Compose stack demonstrated both the
API/dispatcher and the worker/consumer recovering automatically, with
neither process restarted. No recovery timing/duration was measured or
is claimed.

## PostgreSQL connection resilience & worker DB-error backoff (Phase 15)

Addresses two related gaps in how both apps handle their PostgreSQL
dependency failing or hiccuping -- one newly discovered during Phase
15's scoping review, one previously self-identified and tracked since
Phase 4.

**Problem 1 (newly discovered, previously undocumented):**
`apps/api/src/db/pool.ts` and `apps/worker/src/db/pool.ts` both
attached a `pool.on("error", ...)` handler that called
`process.exit(1)` on ANY pool-level error event. A `pg.Pool` emits
`"error"` for an already-connected, currently-IDLE client hitting a
background/network-level failure (e.g. Postgres restarting, a brief
network blip) -- it does not mean every connection is unusable, and
`pg.Pool` already discards the errored client internally and lazily
creates a fresh one on the next query. Neither the API nor the worker
is containerized or process-supervised in this project's real
deployment (`infra/docker-compose.yml` only runs `postgres`/
`rabbitmq`, both with `restart: unless-stopped`; the API and worker run
via `npm run dev` on the host, no restart policy). A single transient
Postgres blip therefore took down the entire API or worker process,
with nothing to bring it back.

(Updated, Phase 16: this describes the *local development* topology,
which is unchanged -- `infra/docker-compose.yml` still only runs
`postgres`/`rabbitmq`, API/worker still run via `npm run dev` on the
host. A separate production topology, `infra/docker-compose.prod.yml`,
now containerizes the API and worker too, each with its own
`Dockerfile` and Docker healthcheck/`depends_on: condition:
service_healthy` gating -- see `docs/deployment.md`. That production
topology has since been run and validated on the project owner's real
Docker Desktop environment (Phase 16 startup/health validation, Phase
17 real chaos-outage verification for both Postgres and RabbitMQ), but
has still not been deployed to any public host; this incident's fix
[Phase 15's pool error handling below] is what actually protects both
topologies, not containerization itself.)

**Problem 2 (previously tracked since Phase 4):**
`failure-handling.md`'s "Known limitations" and
`engineering-decisions.md`'s "Split ACK/NACK behavior by failure
class" decision both flagged: *"NACK+requeue on DB/publish errors has
no backoff -- could hot-loop under a sustained outage."* Confirmed
still true in `apps/worker/src/consumer.ts`: both DB-error catch
blocks called `channel.nack(msg, false, true)` unconditionally, with
zero delay -- a sustained outage (short of triggering Problem 1's pool
crash) could redeliver the same message as fast as RabbitMQ and the
network allow.

**Fix 1 -- pool error handling (both apps' `db/pool.ts`):** the
`pool.on("error")` handler now only logs (via each app's existing
structured logger -- `apps/api/src/db/pool.ts` was additionally
switched from a raw `console.error` to the same pino `logger` already
used everywhere else in that app). No `process.exit()` call remains in
either file. This is deliberately narrow: it only changes the pool's
*background* error handling. Every existing *foreground* query-error
path (the outbox dispatcher's own try/catch, the worker's DB-error
catch blocks below, `routes/health.ts`'s `Promise.allSettled`) is
untouched -- those already handle a failing query correctly per-call-site.

**Fix 2 -- worker DB-error backoff (`apps/worker/src/consumer.ts`):** a
small, local, capped exponential backoff (1s base, doubling, capped at
30s -- the same shape as Phase 14's `resubscribeWithBackoff`, but a
separate, independent mechanism) is applied *before* `channel.nack(msg,
false, true)` in both existing DB-error catch blocks (the initial
`claimJob()` failure, and the "failed to record retry/dead-letter
outcome" failure). A module-level consecutive-error counter drives the
delay and is reset to 0 immediately after any `claimJob()` call that
does not throw. Because the worker already runs with `prefetch(1)`
(one message in flight at a time per process), sleeping before NACK
directly throttles that worker's redelivery rate during a sustained
outage without any RabbitMQ topology change, without a DB write to
track the counter (the DB may be the thing that's down), and without
touching the retry queue's TTL+DLX mechanism or `retryPolicy.ts`'s
job-level backoff formula, which govern a completely different
concern (business-logic processing retries, not infrastructure
liveness).

**Deliberately unchanged:** the outbox dispatcher
(`apps/api/src/outbox/dispatcher.ts`) already tolerates DB errors
adequately via its own per-event try/catch plus a 2-second poll
interval that acts as its own natural backoff -- confirmed by reading
`dispatchOutboxBatch`/`startOutboxDispatcher` during this phase's
scoping; not modified. Phase 14's RabbitMQ connection-recovery logic
(`queue/connection.ts` in both apps) is untouched. The worker's
separate, intentional initial-boot RabbitMQ-connect-failure
`process.exit(1)` in `index.ts` is untouched -- a different dependency
and a different, unrelated decision (Phase 14). The normal
job-processing retry/DLQ semantics (`retryPolicy.ts`, the retry
queue's TTL+DLX mechanism) are untouched. No schema/migration change,
no new RabbitMQ queue, no new dashboard route, no API route/contract
change.

**Validation status:** see `docs/development-log.md`'s Phase 15 entry
and `docs/incidents-and-failures.md`'s Incident 9 for the full, honest
accounting -- in short, real TypeScript builds passed for both apps,
new unit tests were written against a mocked `pg` module (the same
narrow, deliberate exception Phase 14 established for `amqplib`), each
individually type-checked, and a real, sustained PostgreSQL outage
against the actual Docker Compose stack was performed and passed: the
worker (PID 5444) was not restarted, its DB-error backoff was observed
progressing `1s -> 2s -> 4s -> 8s -> 16s -> 30s` (capped), and a
legitimate queued job completed successfully (`attempt_count = 1`)
once Postgres was restored, with `/ready` reporting both dependencies
`"ok"` afterward. Real Jest execution has since also been confirmed
from the user's own environment: API 19/19 suites (84/84 tests),
Worker 6/6 suites (23/23 tests), 25/25 suites and 107/107 tests
combined, including the three new Phase 15 unit tests. This session's
own device-bridge shell still cannot execute Jest itself -- the real
result came from the user's environment, as with every prior phase's
Jest evidence. With both the real chaos test and real Jest execution
now confirmed, Phase 15 is validated end to end: implemented,
unit-tested (and those tests actually run and passing), and proven
against a real, sustained PostgreSQL outage.
