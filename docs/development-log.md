# Development Log

## Phase 0 — Repository Foundation & Infrastructure Setup

**Date:** 2026-09-08

### What we built
- Initialized Git repository with monorepo folder structure
  (apps/api, apps/worker, apps/dashboard, packages/shared, infra, docs, tests)
- Created `infra/docker-compose.yml` defining PostgreSQL 16 and RabbitMQ 3.13
  (management edition) with healthchecks and named volumes
- Brought up both services locally and verified them independently

### Why
Infrastructure must exist and be verified before any application code is
written against it. Building the API or worker first would mean writing
code against assumed behavior rather than a real, running dependency.

### Verification performed
- `docker compose ps` — both containers reached `healthy` status
- PostgreSQL: ran `SELECT version();` inside the container via
  `docker exec`, confirmed PostgreSQL 16.15 responding, correct database
  (`deadletter`) and user (`deadletter`) from compose env vars
- RabbitMQ: logged into management UI at `localhost:15672` as user
  `deadletter`, confirmed dashboard loads, 0 queues/connections/consumers
  as expected (nothing has connected yet)

### Problems encountered
1. **Docker Desktop not running** — `docker compose up` failed with a
   `npipe` connection error. Cause: Docker Desktop application (the GUI)
   was not started, even though the Docker CLI was installed and
   `docker --version` succeeded. Fix: started Docker Desktop manually,
   waited for it to report "running," retried successfully.
2. **Folder path had spaces and an em dash** (original folder name:
   `DeadLetter — Distributed Failure Recovery Platform`). Renamed to
   `deadletter` early, before Docker Compose was introduced, to avoid
   path-related issues with future shell scripts and CLI tools.
3. **`ren` failed on first attempt** with "process cannot access the file"
   — caused by another process (editor/explorer window) holding a handle
   on a file in the folder. Resolved by closing other windows referencing
   the folder before retrying.

### Tests performed
- Manual verification only (see above). No automated tests yet — nothing
  to automate at this stage.

### What remains to be tested
- API/worker actually connecting to these services (Phase 1+)
- Behavior when either service is unavailable (deferred — chaos testing
  is Phase 11)

### New risks introduced
- None yet; infrastructure only, no logic.

### What we learned
- Docker Desktop must be fully running (not just installed) before
  `docker compose` commands will work — the CLI existing is not sufficient.
- Verifying "healthy" status alone isn't enough proof of correctness;
  actually querying Postgres and logging into RabbitMQ's UI confirmed the
  environment variables (user/db/password) were genuinely applied, not
  just that containers started.

## Phase 0 — API Project Scaffolding

**Date:** 2026-09-08

### What we built
- Initialized `apps/api` as an npm workspace member with its own `package.json`
- Installed TypeScript and `@types/node` as devDependencies (hoisted to root
  `node_modules` via npm workspaces)
- Generated and configured `tsconfig.json`: set `rootDir`/`outDir` for a
  proper src → dist compile boundary, and fixed `types` to include `"node"`
  so global Node types (`process`, `Buffer`, etc.) are actually available
- Verified the full TypeScript → JavaScript → Node pipeline works with a
  trivial `console.log` entry point compiled via `tsc` and run via `node`
- Added `build`/`start`/`dev` npm scripts to `apps/api/package.json`

### Why
Scaffolding must be provably working before any real code is written on
top of it — a broken compile step discovered after 500 lines of business
logic is much more expensive to debug than one discovered now, with a
one-line file.

### Problems encountered
1. **Misplaced files from an early `cd` error** — after `npm init -y`
   inside `apps/api`, two `cd ..` commands were run in a row before the
   next commands, landing at the repo root instead of `apps/api`.
   `npm install`, `tsc --init`, and file creation all happened one level
   too high, polluting the repo root with `node_modules`, `tsconfig.json`,
   and `src/`, and modifying the root workspaces `package.json` with an
   unwanted `devDependencies` field.
   **Fix:** deleted the misplaced files/folders, restored the root
   `package.json` to its original clean content, and re-ran the same
   commands from the correct directory (`apps/api`) this time.
2. **`node_modules` and `package-lock.json` reappeared at the repo root
   after installing from inside `apps/api`** — initially looked identical
   to problem #1. Verified this was actually correct npm workspaces
   behavior (dependency hoisting to a single root `node_modules`/lockfile
   across all workspace members), not a repeat mistake, by confirming
   `typescript`/`@types/node` were correctly recorded under
   `apps/api/package.json`'s `devDependencies` and the root `package.json`
   was untouched.
3. **`tsc --init` defaults were not directly usable**: `rootDir`/`outDir`
   were commented out (no defined src → dist boundary), and `"types": []`
   explicitly excluded Node's global types despite `@types/node` being
   installed. Both were fixed manually before the build was verified.

### Tests performed
- `npx tsc` — compiled with no errors
- `node dist/index.js` — printed expected output, confirming the compiled
  output is actually runnable
- `npm run dev` — confirmed the convenience script produces the same
  result as running the two commands manually

### What remains to be tested
- No real application logic yet — this only proves the toolchain works

### New risks introduced
- None; scaffolding only

### What we learned
- npm workspaces hoist dependencies to a single root `node_modules` and
  `package-lock.json` by default — a workspace member's own
  `node_modules` folder not existing locally is expected, not a bug, as
  long as the dependency is correctly recorded in that member's own
  `package.json`
- `tsc --init`'s generated config is not immediately usable as-is for a
  Node project — `rootDir`/`outDir` and the `types` array need explicit
  configuration

  
## Phase 0 — Worker Project Scaffolding

**Date:** 2026-09-08

### What we built
- Initialized `apps/worker` as an npm workspace member, mirroring the
  `apps/api` scaffolding: TypeScript + `@types/node`, configured
  `tsconfig.json` (rootDir/outDir, node types), `build`/`start`/`dev`
  npm scripts
- Verified the compile-and-run pipeline with a trivial entry point

### Why
The worker is a separate process from the API but will eventually share
code (job status types, DB models) via `packages/shared`. Scaffolding
both apps identically now means shared code can be introduced once, for
both consumers, rather than retrofitted onto the worker later.

### Problems encountered
- None — this repeated the exact steps already debugged for `apps/api`,
  so no new issues surfaced.

### Tests performed
- `npm run dev` inside `apps/worker` — compiled and ran successfully,
  printed expected output

### What remains to be tested
- No real worker logic yet (RabbitMQ consumption starts Phase 2/3)

### New risks introduced
- None; scaffolding only

### What we learned
- Nothing new — confirms the API scaffolding process is repeatable and
  the earlier `cd` mistake was avoidable once understood


## Phase 1 — Environment Config, DB Pool, and jobs Table

**Date:** 2026-09-08

### What we built
- Zod-validated environment configuration (`src/config/env.ts`)
- PostgreSQL connection pool (`src/db/pool.ts`) using `pg`, verified
  against the real running container with a `SELECT NOW()` query
- `jobs` table schema (`infra/init-db/001_create_jobs_table.sql`),
  applied directly to the running Postgres container and verified via
  `\d jobs`

### Why
Establishing config validation and a real, proven DB connection before
writing any route/business logic means later code can be written
against a known-working foundation instead of debugging the foundation
and the feature at the same time.

### Problems encountered
1. TypeScript `verbatimModuleSyntax`/CommonJS conflict — see
   `incidents-and-failures.md`, Incident 1.
2. `infra/init-db/` directory was missing when we went to create the SQL
   file, despite being part of the original Phase 0 folder structure.
   Cause not fully determined (possibly never actually created in the
   original batch `mkdir -p`, since Windows `mkdir` does not support
   `-p` the same way and may have silently failed on nested paths).
   Fix: recreated the directory directly before creating the SQL file.
   No data loss since the folder was never used before this point.

### Tests performed
- `npm run dev` with real DB pool — confirmed live connection to
  Postgres container via `SELECT NOW()`, returned real timestamp
- Ran table creation SQL directly against the container via
  `docker exec` + `psql`, confirmed `CREATE EXTENSION`, `CREATE TABLE`,
  `CREATE INDEX` all succeeded
- `\d jobs` — confirmed real schema matches design: all columns, types,
  defaults, primary key, status index, and CHECK constraint present

### What remains to be tested
- Actual INSERT via application code (job service, next step)
- Behavior when the CHECK constraint is violated (deferred until we
  write code that could trigger it)

### New risks introduced
- None; schema only, no application logic writing to it yet

### What we learned
- Windows `mkdir -p`-style nested directory creation is not guaranteed
  the same way as on Unix; worth verifying directory structure exists
  before assuming it from an earlier step, especially on this platform

  
## Phase 1 — Job Validation Schema and Job Service

**Date:** 2026-09-08

### What we built
- `src/validation/jobSchema.ts` — Zod schema for `POST /api/jobs` input
  (`type`: non-empty string, `payload`: object), with `CreateJobInput`
  type derived via `z.infer`
- `src/services/jobService.ts` — `createJob` (parameterized INSERT with
  RETURNING) and `getJobById` (parameterized SELECT), both using the
  real connection pool

### Why
Validation and persistence logic are built and manually proven correct
in isolation, before either touches Express — keeping HTTP concerns
completely separate from input-shape rules and SQL.

### Problems encountered
- See `incidents-and-failures.md`, Incident 2 (`noUncheckedIndexedAccess`
  flagging `createJob`'s return type)

### Tests performed
- Manual script exercising `createJobSchema.safeParse` with one valid
  and two invalid inputs — confirmed correct pass/fail behavior and
  error messages, then removed the throwaway test file
- Manual end-to-end run via `index.ts`: called `createJob`, confirmed a
  real row was inserted into Postgres with correct defaults (UUID,
  `QUEUED` status, `attempt_count: 0`, `max_attempts: 5`, timestamps);
  called `getJobById` with the returned id, confirmed the same row was
  fetched back correctly

### What remains to be tested
- Express route wiring (next step)
- Behavior when `getJobById` is called with a non-existent id (should
  return `null` per its type signature — not yet exercised)
- Automated tests (deferred to Phase 9, currently only manual scripts)

### New risks introduced
- None; still pre-HTTP, isolated logic only

### What we learned
- `noUncheckedIndexedAccess` is a genuinely useful strictness setting
  for this project, not just friction — it caught a real implicit
  assumption in `createJob`

  
## Phase 1 — Express App, Job Routes, End-to-End Verification

**Date:** 2026-09-08

### What we built
- `src/app.ts` — Express app with `pino-http` structured request logging
  and JSON body parsing
- `src/routes/jobs.ts` — `POST /api/jobs` and `GET /api/jobs/:id`,
  wired to the validation schema and job service
- `src/index.ts` updated to actually start the HTTP server
- `GET /api/health` as a minimal liveness route

### Why
This is the point where validation, persistence, and HTTP finally
connect into the real request lifecycle described in the Phase 1 goal.

### Tests performed (all against the real running server + database)
- `GET /api/health` — 200, confirmed pino-http logs both an explicit
  log line and an automatic "request completed" line, both tagged with
  the same request id
- `POST /api/jobs` with valid body — 201, real job persisted, real
  jobId returned, confirmed via server log
- `GET /api/jobs/:id` with that real id — 200, full job row returned,
  matched what was created
- `POST /api/jobs` with `{}` — 400, Zod correctly reported both missing
  fields (`type`, `payload`) in the response body

### What remains to be tested
- `GET /api/jobs/:id` with a non-existent id (404 path — schema
  supports it via `getJobById` returning `null`, not yet exercised via
  HTTP)
- Automated tests (Phase 9)
- Behavior under concurrent requests

### New risks introduced
- None beyond what already existed; this wires together already-proven
  pieces

### What we learned
- pino-http's automatic request id correlation works as designed —
  visibly confirmed in real log output, not just assumed from docs

## Phase 1 — Status: Core loop complete

Submit → validate → persist → return jobId + QUEUED, and fetch by id,
both proven end-to-end with real HTTP requests. RabbitMQ, retries, and
the dashboard are explicitly out of scope for this phase per the
original brief — jobs currently just sit as QUEUED with nothing moving
them forward, which is expected until Phase 2.


### Addendum — 404 path verified

`GET /api/jobs/:id` with a non-existent id was manually tested over
real HTTP: returned `404` with `{"error":"Job not found"}`, logged
correctly via pino-http. All three response paths for Phase 1
(`201`, `400`, `404`) are now confirmed against the real running
server, not just assumed from code review.


## Phase 2 — RabbitMQ Connection Module (API side)

**Date:** 2026-09-09

### What we built
- Added `RABBITMQ_URL` to environment config (`.env`, `.env.example`,
  Zod schema in `env.ts`)
- Installed `amqplib` (v2.0.1) and its type definitions
- `src/queue/connection.ts` — API-side connection module declaring our
  topology (`deadletter.jobs.exchange`, `deadletter.jobs.queue`, bound
  with routing key `job.created`), with `getChannel()`/`closeConnection()`

### Why
Establish and prove a real connection to RabbitMQ, with topology
declared in code, before writing any publish logic on top of it.

### Problems encountered
- None directly, but verified before assuming: `amqplib` installed at
  v2.0.1, notably newer than expected from general knowledge. Checked
  release notes before writing code — confirmed `amqp.connect()` now
  returns a `ChannelModel` type (renamed from `Connection` as of
  0.10.7+), but core method surface (`createChannel`, `assertExchange`,
  `assertQueue`, `bindQueue`, etc.) is unchanged. No code impact beyond
  using the correct type name.

### Tests performed
- Manual script: connected, declared topology, closed connection —
  succeeded with no errors
- Verified visually in RabbitMQ management UI: exchange count went
  from 7 → 8 (our new `deadletter.jobs.exchange`, type `direct`,
  durable), queue count went from 0 → 1 (`deadletter.jobs.queue`,
  durable, running), and the queue's Bindings section confirmed the
  binding from our exchange with routing key `job.created`

### What remains to be tested
- Actually publishing a message (next step)
- Worker-side connection and consumption
- What happens if RabbitMQ is unreachable when the API tries to connect

### New risks introduced
- None yet; connection and topology declaration only, no publish/consume
  logic

### What we learned
- Checking a dependency's actual installed version and changelog before
  writing code against it (rather than relying on training-data memory
  of its API) avoided writing code against an outdated type name
- RabbitMQ's management UI is a genuinely useful verification tool —
  confirms real broker state, not just "the script didn't throw"


## Phase 2 — Publisher Wired Into Job Creation

**Date:** 2026-09-09

### What we built
- `src/queue/publisher.ts` — `publishJobCreated(jobId)`, publishes a
  thin `{ jobId }` message to `deadletter.jobs.exchange` with routing
  key `job.created`, marked `persistent: true`
- Wired into `jobService.createJob` — every real job creation now
  publishes a message after the DB insert succeeds

### Why
Complete the basic API → Postgres → RabbitMQ path end-to-end, so the
worker (next step) has real messages to consume against.

### Tests performed
- Manual isolated test: published a message directly, confirmed via
  RabbitMQ UI (Ready: 1, Persistent: 1)
- Real end-to-end test via `POST /api/jobs`: created a real job via
  HTTP, confirmed message appeared in queue (Ready: 2, Persistent: 2),
  matching the two independent publishes (one manual, one via the real
  API flow)

### Observations
- `POST /api/jobs` response time increased from ~10-40ms (Phase 1,
  DB-only) to ~167ms with the RabbitMQ publish now happening
  synchronously in the request path. Not addressed yet — noting it as
  a real, measured observation, not a problem to fix prematurely.
  Relevant to revisit if/when this becomes a genuine bottleneck under
  load testing (Phase 10).

### What remains to be tested
- Worker consuming these exact messages (next step) — two real
  messages are currently sitting in the queue, deliberately left
  unconsumed, to be picked up by the first working consumer
- DB write succeeding but publish failing (the tracked consistency
  problem) — still not yet deliberately reproduced

### New risks introduced
- The DB insert and RabbitMQ publish are two separate, non-atomic
  operations in `createJob`. If the publish fails after a successful
  insert, the job would be persisted as QUEUED with no worker ever
  notified. Not yet handled — tracked, to be reproduced and analyzed
  once the worker exists.

### What we learned
- Publishing synchronously inside the request path has a measurable
  latency cost — a real, observed trade-off, not a theoretical one


## Phase 2 — Worker Scaffolding, Connection Module, and Build Safety Fix

**Date:** 2026-09-09

### What we built
- Worker environment config (`src/config/env.ts`), mirroring the API's
  pattern (no `PORT`, since the worker isn't an HTTP server)
- Worker RabbitMQ connection module (`src/queue/connection.ts`), same
  topology constants as the API
- Verified the worker can independently connect and confirm the
  already-existing topology (idempotent declaration, exercised from a
  second real process)
- Added `noEmitOnError: true` to both `apps/api` and `apps/worker`
  tsconfig files

### Why
Prove the worker can connect using its own independent config/connection
code before writing consumer logic on top of it.

### Problems encountered
- See `incidents-and-failures.md`, Incident 3 — same
  `verbatimModuleSyntax` issue as Incident 1, not caught earlier because
  the worker had no import/export code until now; additionally revealed
  that `tsc` was silently emitting output despite reported errors in
  both apps, now fixed with `noEmitOnError`

### Tests performed
- `npx tsc` in `apps/worker` — 15 errors on first run, 0 after fix
- `npx tsc` in `apps/api` — confirmed still 0 errors after adding
  `noEmitOnError` (regression check on an already-working app)
- `node dist/queue/test-manual.js` in worker — confirmed real
  connection to RabbitMQ succeeds and topology is confirmed idempotently
  from a second process

### What remains to be tested
- Actual message consumption (next step)

### New risks introduced
- None; this closes a risk (silent broken builds) rather than opening
  one

### What we learned
- `noEmitOnError` should probably be a default we set immediately when
  scaffolding any future workspace member, rather than discovered
  reactively


## Phase 2 — Consumer Built and Verified End-to-End

**Date:** 2026-09-09

### What we built
- `src/consumer.ts` — connects to `deadletter.jobs.queue`, sets
  `prefetch(1)`, consumes with manual ACK (`noAck: false`), parses
  message JSON, logs, acknowledges
- `src/index.ts` updated to start the consumer as a long-running process

### Why
Close the loop on the basic messaging path: prove a message published
by the API is actually received and acknowledged by an independent
worker process.

### Tests performed
- Started the worker with two real messages already waiting in the
  queue (one manual test publish, one from an actual `POST /api/jobs`
  HTTP request made earlier in this phase)
- Confirmed both messages were received in order, correctly parsed
  (jobId matched exactly what was published), and acknowledged
- Confirmed via RabbitMQ management UI: Ready and Unacked both dropped
  from 2/0 to 0/0 immediately upon worker connection; delivery graph
  showed the "Deliver (manual ack)" spike matching our consume mode

### What remains to be tested
- Multiple workers running simultaneously (competing consumers)
- Worker crashing before ACK (should trigger redelivery)
- RabbitMQ becoming unavailable mid-publish (the tracked DB/RabbitMQ
  consistency problem)
- Worker actually updating job status in Postgres (Phase 3 — currently
  the worker only logs, doesn't touch the database)

### New risks introduced
- None beyond what's already tracked; consumer currently always ACKs
  unconditionally regardless of whether real processing would have
  succeeded — acceptable for this phase's scope (proving delivery),
  will become a real gap once Phase 3 adds actual processing logic
  that can fail

### What we learned
- The full API → Postgres → RabbitMQ → Worker path is genuinely
  working, not just individually-tested pieces assumed to compose
  correctly — confirmed by watching two independently-created real
  messages (different origins, different times) both get consumed
  correctly by a process started well after they were published


## Phase 2 — Competing Consumers Verified

**Date:** 2026-09-09

### What we tested
Ran two worker processes simultaneously against the same queue, created
4 jobs via real HTTP requests, observed which worker consumed each.

### Result
Clean alternation across both workers (1st→W1, 2nd→W2, 3rd→W1, 4th→W2),
confirmed via worker terminal logs and cross-checked against jobIds
returned by the API. RabbitMQ management UI confirmed Consumers: 2
before the test began.

### Why this matters
Confirms horizontal scaling of workers requires zero code changes —
"run more worker processes" is genuinely the entire mechanism, not
something requiring additional coordination logic we'd need to build.

### What remains to be tested
- Worker crashing before ACK — should trigger redelivery (next step)
- RabbitMQ unavailable during publish — the tracked consistency problem


## Phase 2 — Deliberate Redelivery Test

**Date:** 2026-09-09

### What we tested
Deliberately killed a worker process mid-processing (before ACK) to
observe whether RabbitMQ actually redelivers the unacknowledged message,
rather than assuming this behavior from documentation.

### Result
Confirmed working exactly as expected. Full details in
`incidents-and-failures.md`, Deliberate Test 1. Message was never lost;
automatically redelivered to a new worker upon reconnection.

### Why this matters
This is the foundational reliability guarantee the entire failure-
handling design (Phases 4-6: retries, DLQ, replay) depends on. Verifying
it directly, by causing and observing a real crash, is more trustworthy
than assuming RabbitMQ's documented behavior applies correctly to our
specific setup (durable queue + persistent messages + manual ACK mode).

### What remains to be tested
- RabbitMQ itself becoming unavailable during a publish (the tracked
  DB/RabbitMQ consistency problem) — next test
- Worker updating job status in Postgres (Phase 3 scope)

### New risks introduced
- None; this test confirms existing infrastructure behavior, doesn't
  change it

### What we learned
- At-least-once delivery (what we just proved) is a different, weaker
  guarantee than exactly-once execution. Redelivery solves "did the
  message get lost" but actively creates "could this get processed
  twice" — both are real, and Phase 5's idempotency work directly
  addresses the second one, now backed by a concrete observed scenario
  rather than an abstract concern

  
## Phase 3 -- Worker Processing Implementation

**Date:** 2026-09-09

### What we built
- Worker DB pool (structured logger for pool errors, no circular
  dependency -- logger.ts depends only on config/env.ts), job service
  (markProcessing/markCompleted/markFailed), stub job processor with
  deterministic failure hook (payload.shouldFail)
- Consumer rewritten to drive the full QUEUED -> PROCESSING ->
  COMPLETED|FAILED lifecycle, with ACK/NACK strategy split by failure
  class (see engineering-decisions.md)
- New docs/failure-handling.md

### Why
Worker now does real work against Postgres instead of only logging --
this is the core of "DeadLetter" as a functioning system.

### Dependencies / schema changes
None -- pg/pino were already installed for the worker; using existing
jobs table columns (attempt_count, last_error, status, updated_at).

### Tests performed

All tests run against the real Postgres/RabbitMQ containers and real
worker process, not simulated.

1. **Success path**: `POST /api/jobs` with `type: phase3_success_test`,
   empty payload. Worker log showed `Marking job as PROCESSING` ->
   `Job completed successfully`. DB confirmed: status=COMPLETED,
   attempt_count=1, last_error=NULL (jobId c233ef82-f347-49c3-b68b-510fdc6f9b24).

2. **Failure path**: `POST /api/jobs` with `type: phase3_failure_test`,
   `payload.shouldFail=true`. Worker log showed `Marking job as
   PROCESSING` -> `Job processing failed, marked as FAILED` (warn
   level). DB confirmed: status=FAILED, attempt_count=1,
   last_error="Simulated failure for job type \"phase3_failure_test\""
   (jobId 0747e2ae-dd83-4a91-a8ae-1ba81655c56d).

3. **RabbitMQ queue state**: confirmed via management UI after both
   tests: Ready=0, Unacked=0, Total=0 -- both messages fully consumed
   and acknowledged, nothing stuck in-flight.

4. **Terminal-state guard**: manually re-published a message
   (`{"jobId":"c233ef82-..."}`) for the already-COMPLETED job directly
   via the RabbitMQ management UI (simulating redelivery). Worker
   logged `Job already in terminal state, skipping (likely
   redelivery), acknowledging` (warn level) and ACKed without
   reprocessing. Confirmed via DB query: attempt_count remained 1
   (not incremented to 2), proving markProcessing was never called
   for the redelivered message.

5. **Build**: `npm run dev` (which runs `tsc && node dist/index.js`)
   succeeded end-to-end for all above tests; since `noEmitOnError:
   true` is set in tsconfig, a failed compile would have blocked
   execution entirely -- the worker running confirms a clean compile.

### What remains to be tested
- Concurrent workers racing on the same redelivered message (the
  terminal-state guard's known gap -- Phase 5 territory, not expected
  to be safe yet)
- Retry/backoff/DLQ behavior -- Phase 4
- Sustained DB outage causing NACK+requeue hot-loop -- not yet
  observed, tracked as a known limitation

### New risks introduced
- None beyond what's already tracked in failure-handling.md

### What we learned
- The terminal-state guard, though simple, verifiably prevents the
  exact redelivery-reprocessing scenario demonstrated in Phase 2 --
  confirmed by both a log line and unchanged attempt_count, not
  assumed from reading the code


## Phase 4 -- Retry, Exponential Backoff, and Dead Letter Queue

**Date:** 2026-09-09

### What we built
- New failures exchange + retry queue (TTL+DLX-based delay mechanism,
  no plugin) + DLQ, worker-only topology
- retryPolicy.ts (exponential backoff, pure function)
- NonRetryableError for retryable/terminal classification
- jobService: markRetrying, markDeadLettered added; markFailed retained
  but no longer called by the consumer
- jobProcessor: shouldFailPermanently test hook added alongside existing
  shouldFail
- consumer.ts: full retry/DLQ orchestration, updated terminal-state
  guard (RETRYING excluded, DEAD_LETTERED and FAILED included)

### Why
Completes the core "DeadLetter" failure-handling story: a failure is
never simply a dead end -- it's either retried with backoff or
explicitly, observably dead-lettered.

### Database / dependency changes
None -- schema already supported RETRYING/DEAD_LETTERED since Phase 1;
no new packages or env vars.

### Tests performed

All tests run against real Postgres/RabbitMQ containers and the real
worker process.

1. **Test A — non-retryable failure (NonRetryableError path)**:
   `POST /api/jobs` with `type: phase4_nonretryable_test`,
   `payload.shouldFailPermanently=true`. Worker log showed
   `Marked job as PROCESSING` (attempt 1) -> `Job failed permanently,
   sent to DLQ` (reason: non-retryable), immediately, no retry attempted.
   DB confirmed: status=DEAD_LETTERED, attempt_count=1
   (jobId cf051023-8001-4a91-ae6a-9c2c8ec51215). RabbitMQ UI confirmed
   deadletter.jobs.dlq: Ready=1.

2. **Test B — retryable failure through full exhaustion**:
   `POST /api/jobs` with `type: phase4_retry_test`,
   `payload.shouldFail=true`. Worker log showed 5 full attempt cycles.
   Measured actual gaps between failure and next attempt against the
   calculated exponential backoff:
   - attempt 1->2: scheduled 2000ms, actual 2011ms
   - attempt 2->3: scheduled 4000ms, actual 4011ms
   - attempt 3->4: scheduled 8000ms, actual 8004ms
   - attempt 4->5: scheduled 16000ms, actual 16032ms
   All within ~10-30ms of the calculated backoff (normal scheduling
   overhead) -- confirms the TTL+DLX retry mechanism produces accurate,
   real delays, not approximate ones. Attempt 5 correctly triggered
   exhaustion (reason: attempts-exhausted) rather than another retry.
   DB confirmed: status=DEAD_LETTERED, attempt_count=5
   (jobId bd1c4f20-66c3-4710-9690-94d1865d8c23).

3. **RabbitMQ queue state after both tests**: deadletter.jobs.dlq
   Ready=2 (both jobs), deadletter.jobs.queue Ready=0,
   deadletter.jobs.retry.queue Ready=0 -- confirmed via management UI,
   all three queues checked simultaneously. Retry queue's Features
   column independently displayed by RabbitMQ as D/DLX/DLK, confirming
   the broker's own read of our topology declaration (durable, dead
   letter exchange + routing key configured) matches intent.

4. **Build**: `npx tsc` completed silently (zero errors) prior to
   worker startup; `noEmitOnError` guarantees this given the worker ran
   successfully.

### What remains to be tested
- DLQ consumption/inspection (Phase 6 -- currently DLQ messages simply
  accumulate, unconsumed, by design this phase)
- Concurrent workers racing on a redelivered RETRYING-status job (Phase
  5 -- terminal-state guard's known gap, not expected to be safe yet)
- Sustained DB/publish outage during retry-scheduling causing
  NACK+requeue hot-loop -- not yet observed, tracked as a known
  limitation

### New risks introduced
- None beyond what's already tracked in failure-handling.md (per-message
  TTL expiry ordering not strictly guaranteed by RabbitMQ; NACK+requeue
  has no backoff)

### What we learned
- The TTL+DLX pattern's timing was independently verified against wall-
  clock timestamps, not assumed from RabbitMQ documentation -- measured
  gaps matched calculated backoff within normal scheduling overhead
  across all 4 retry cycles
- RabbitMQ's management UI Features column (D/DLX/DLK) provides a
  broker-side confirmation of queue configuration independent of our
  own code, useful as a second source of truth when verifying topology


## Phase 5 -- Pre-execution test-design review

**Date:** 2026-09-09

Before running any tests, reviewed the concurrency-test procedure
specifically for determinism. Found the originally planned
CLAIM_TEST_DELAY_MS (fixed relative delay) insufficient to guarantee a
genuine race between two independent worker processes, and found the
originally planned Test 3 did not actually exercise the scenario its
name implied, due to prefetch(1) serializing delivery to a single
consumer. Both issues fixed before execution -- see
engineering-decisions.md for full detail. claimJob() and jobService.ts
are unchanged; only consumer.ts's test hook and env.ts were revised.

No tests have been executed yet. Results remain pending.


## Phase 5 -- Incident found and fixed during testing

**Date:** 2026-09-09

While setting up Test 3, an accidental malformed jobId (placeholder
text left in a manually-published RabbitMQ message) triggered a real
infinite redelivery loop. Diagnosed, fixed, and verified -- full detail
in incidents-and-failures.md, Incident 4. consumer.ts's claim catch
block now distinguishes Postgres invalid-UUID errors (22P02, ack +
discard) from genuine infrastructure errors (nack + requeue, unchanged).


## Phase 5 -- Real Test Results

**Date:** 2026-09-09

All tests run against real Postgres/RabbitMQ containers and real
worker process(es), not simulated.

1. **Test 1 (normal success):** jobId 47bf7c31-ff6f-43b8-a2f0-5c2c7942ee27.
   Worker log confirmed full claimJob-based flow: Attempting atomic
   claim -> Claimed job, marked PROCESSING (attempt 1) -> Executing
   processJob() -> Job completed successfully. DB confirmed COMPLETED,
   attempt_count=1.

2. **Test 2 (retry/backoff/DLQ, unchanged from Phase 4):**
   jobId b5d9b711-0b4c-4e33-81eb-1b90e1b4dbaa. Measured actual gaps
   between failure and next claim against calculated exponential
   backoff: attempt 1->2 scheduled 2000ms/actual 2008ms; 2->3 scheduled
   4000ms/actual 4004ms; 3->4 scheduled 8000ms/actual 8005ms; 4->5
   scheduled 16000ms/actual 16009ms. All within ~10ms of calculated
   values -- confirms the claimJob rewrite did not alter retry timing.
   Attempt 5 correctly exhausted -> DEAD_LETTERED. DB confirmed
   DEAD_LETTERED, attempt_count=5.

3. **Incident found and fixed during setup (see incidents-and-failures.md,
   Incident 4):** an accidentally malformed jobId (leftover placeholder
   text in a manually-published message) triggered a genuine infinite
   redelivery loop, confirmed via RabbitMQ UI showing sustained ~31
   deliveries/sec. Root cause: claimJob's catch block treated all
   thrown errors as transient infra failures and unconditionally
   requeued. Fixed by detecting Postgres error code 22P02
   (invalid_text_representation) and acking-and-discarding instead.
   Verified fixed by deliberately reproducing with a known-invalid
   jobId: exactly one log line, zero redelivery loop, queue settled
   to Ready=0/Unacked=0/Total=0.

4. **Test 3 (duplicate delivery after COMPLETED, reframed per
   pre-execution review):** jobId 8b2523f6-60f4-4e02-a8fe-954776ca5571.
   Original delivery completed normally. Manually republished duplicate
   72 seconds later: worker logged "Claim failed -- job not in
   claimable state" with currentStatus=COMPLETED, correctly ACKed
   without reprocessing. DB confirmed unchanged: COMPLETED,
   attempt_count=1.

5. **Test 4 (genuine concurrent claim race -- the critical test):**
   jobId c67e22d7-e8eb-42a0-bf81-c4c82de58921. Two independent worker
   processes (pids 3592 and 160/verified distinct) synchronized via
   CLAIM_TEST_SYNC_EPOCH_MS to the same absolute wall-clock target
   after an initial attempt revealed the target had already elapsed by
   the time manual test steps were completed (~90s buffer insufficient
   for manual UI steps; retried with 180s buffer, confirmed both
   workers logged "Sleeping until synchronized claim-test target time"
   with correct matching target before the race).
   Both workers' "Attempting atomic claim" fired within 1ms of each
   other (372297 vs 372298, raw epoch ms). The losing worker's claim
   failure reported currentStatus=PROCESSING (not a stale terminal
   status), directly evidencing genuine contention for the row at the
   moment of the race, not a sequential near-miss. Exactly one worker
   logged "Executing processJob()" and completed; the other was
   correctly ACKed without processing. DB confirmed the critical
   assertion: COMPLETED, attempt_count=1 (not 2).

6. **Test 5 (stale-PROCESSING reclaim):** jobId
   a2df0f1a-426a-4b43-9cd4-788b8c581b22. Actual sequence differed from
   the originally planned "simulate a mid-flight crash" scenario: the
   worker auto-claimed and completed the job (attempt 1) before the
   manual backdating UPDATE could be run by hand. The UPDATE then
   forcibly overwrote the already-COMPLETED row's status back to
   PROCESSING with a 90s-stale updated_at. A subsequently republished
   duplicate correctly matched the staleness-reclaim branch (the
   mechanism evaluates only current row state, not history) and
   reclaimed it, incrementing attempt_count 1->2 and completing again.
   This still validly demonstrates the staleness-reclaim mechanism
   functioning correctly on a genuinely stale-PROCESSING row, though
   the path by which that row reached that state differed from the
   original test plan. Documented honestly rather than re-run to force
   the originally intended narrative.

### What remains to be tested
- A "clean" version of Test 5 where the target job is deliberately slow
  (e.g. via a test-only processing delay) so the backdate UPDATE lands
  while the job is still genuinely mid-flight, rather than after
  natural completion -- not performed; current evidence is considered
  sufficient given the mechanism is provably state-based, not
  history-based
- Sustained DB/publish outage during retry-scheduling causing
  NACK+requeue hot-loop -- not yet observed, tracked as a known
  limitation carried from Phase 4

### New risks introduced
- None beyond what's tracked; Incident 4 was found and fixed within
  this phase, not left open

### What we learned
- Manual timing-based test coordination (the original relative-delay
  approach) is unreliable for proving genuine concurrency; an absolute
  shared target timestamp, verified via explicit "sleeping until target"
  log lines before trusting any race result, is necessary
- A real bug (Incident 4) was found specifically because testing was
  performed with real infrastructure and real manual interaction, not
  code review alone -- direct validation of the project's testing
  philosophy
- The losing side's rejection reason (currentStatus at time of failure)
  is meaningful diagnostic evidence for whether a race was genuine
  (PROCESSING) versus sequential-after-the-fact (a terminal status)


## Phase 6 -- DLQ Inspection + Safe Replay: Implementation and Real Test Results

**Date:** 2026-09-09 (session date per timestamps; note: some earlier
Phase 6 session timestamps reference 2026-09-10 due to date rollover
mid-session)

### What we built
- Migration 002: total_attempt_count, replay_count,
  last_dead_lettered_at, last_dead_letter_reason columns
- apps/worker/src/services/jobService.ts: claimJob now also increments
  total_attempt_count (same atomic UPDATE, WHERE clause unchanged from
  Phase 5); markDeadLettered now also records
  last_dead_lettered_at/reason
- apps/api/src/services/jobService.ts: new claimReplay (atomic
  DEAD_LETTERED->QUEUED conditional UPDATE)
- apps/api/src/validation/jobSchema.ts: jobIdParamSchema (UUID format)
- apps/api/src/config/env.ts: REPLAY_TEST_DELAY_MS (test-only, default 0)
- apps/api/src/routes/jobs.ts: POST /:id/replay; UUID validation added
  to GET /:id and the new route

consumer.ts was NOT modified -- confirmed the design goal that replay
requires zero changes to the existing worker claim/retry/DLQ logic.

### Real test results (all against real Postgres/RabbitMQ/worker/API, no fabrication)

**Test 1 -- basic replay, unresolved failure (jobId
6d0addf3-921c-47f5-86bb-ca495545d415):** Created with
shouldFailPermanently=true, dead-lettered immediately (non-retryable
path). Replayed: 200, replayCount=1. Worker log confirmed attempt reset
to 1 (not 2) before re-incrementing, re-failed via the same
non-retryable condition, dead-lettered again. Final DB: DEAD_LETTERED,
attempt_count=1, total_attempt_count=2, replay_count=1,
last_dead_lettered_at populated.

**Test 2 -- replay to success (jobId
03a4cfcd-72d3-4e32-925d-5bef85425ceb):** Created with shouldFail=true,
exhausted all 5 attempts with backoff timing matching calculated values
within ~10-40ms (2000/2039, 4000/2021->actually measured against
raw logs: attempt gaps 2054ms, 4017ms, 8009ms, 16018ms against
scheduled 2000/4000/8000/16000 -- consistent with Phase 4/5 precision),
reached DEAD_LETTERED, attempt_count=5, total_attempt_count=5. Payload
manually cleared (UPDATE jobs SET payload='{}') to simulate "underlying
issue fixed." Replayed: 200, replayCount=1. Worker log showed a single
clean attempt (no retry) -> COMPLETED. Final DB: COMPLETED,
attempt_count=1, total_attempt_count=6, replay_count=1,
last_dead_lettered_at still populated (was_ever_dl=true) -- confirms
dead-letter history survives eventual success.

**Test 3 -- invalid-state rejections (jobId
2ca21851-e189-48aa-8196-d3bc43ddc101 + synthetic ids):** Real job
completed before replay was attempted; replay correctly returned 409
with currentStatus="COMPLETED". Nonexistent UUID
(00000000-0000-0000-0000-000000000000) returned 404. Malformed id
("not-a-uuid") returned 400 on both POST /:id/replay and GET /:id.

**Test 4 -- genuine concurrent replay race (jobId
26a1f8db-6822-4563-86e0-16e2e505ed60), the critical test:** Created
with shouldFailPermanently=true, dead-lettered. API restarted with
REPLAY_TEST_DELAY_MS=3000. Two replay requests fired via a PowerShell
Start-Job script; server received them 5ms apart (raw epoch:
1789048063474 vs 1789048063479). Both independently completed their
3000ms delay and reached "Attempting replay claim" 14ms apart (raw
epoch: 1789048066488 vs 1789048066502). Winner: 200, replayCount=1.
Loser: 409, currentStatus="QUEUED" (the winner's post-state, NOT a
stale DEAD_LETTERED read -- direct evidence of genuine database-layer
contention, not a sequential near-miss). Final DB confirmed the
critical assertion: replay_count=1, not 2. (Job subsequently re-failed
and re-dead-lettered after the replay, since shouldFailPermanently was
never cleared for this job -- expected and correct given that payload.)

**Test 5 -- DLQ Ready count unaffected by replay:** After Test 2's job
reached COMPLETED via replay, deadletter.jobs.dlq showed Ready=10,
Total=10 -- confirmed via RabbitMQ management UI screenshot. Count
reflects all dead-letter events accumulated across this and prior test
sessions (Phase 4/5 leftovers plus this phase's own); replaying a job
to success did not decrement it. Confirms the documented tradeoff is
real, not just asserted.

### What remains to be tested (explicitly not verified this phase)
- Replay rejection for a job in PROCESSING state specifically (relies
  on the same WHERE clause verified against COMPLETED/QUEUED, not
  independently exercised)
- Replay rejection for a job in RETRYING state specifically (same)
- Sustained dual-write failure on replay (DB succeeds, publish fails) --
  not deliberately reproduced this phase, same class of risk as the
  Phase 0/2 finding, not re-tested here

### New risks introduced
- Same dual-write risk as Phase 0/2, now also present on the replay
  write path (DEAD_LETTERED->QUEUED update succeeding while the
  subsequent publish fails). Documented, not solved, consistent with
  the project's standing decision.

### New incidents
- None. No bugs were found during Phase 6 implementation or testing.

### What we learned
- The Phase 5 concurrency-test methodology (absolute or sufficiently-
  aligned relative delay + explicit "attempting claim" timestamp
  logging + the loser's observed intermediate state as diagnostic
  evidence) generalizes cleanly to a second, structurally similar
  atomic-claim scenario (replay) without needing new invention
- A relative per-request delay is valid for proving concurrency when
  both requests are dispatched by the same controlling script within
  milliseconds of each other (this test) -- unlike Phase 5's original
  flawed CLAIM_TEST_DELAY_MS, where delay was relative to two
  independently-arriving RabbitMQ messages with no guaranteed
  closeness in arrival time


## Phase 6 -- Verification: Real Test Results

**Date:** 2026-09-10

All results below are from actual command execution against real
PostgreSQL/RabbitMQ/API/worker processes during this verification
session. No result is fabricated or upgraded from a lesser evidence
category.

### Migration
Applied via ALTER TABLE ... ADD COLUMN IF NOT EXISTS against the live
container (correct method given the existing data volume -- init-db
scripts only auto-run on first initialization). Verified via both
`\d jobs` and `information_schema.columns` query -- all 4 new columns
match approved types/nullability/defaults exactly.

### Test 1 -- Basic replay: PASS, with one sub-item NOT CAPTURED
Job e25c2f4a-a3b8-4610-b46f-3c493bc0f17d. Pre-replay DEAD_LETTERED
state VERIFIED (attempt_count=1, replay_count=0, dead-letter metadata
populated). HTTP 200 replay response VERIFIED. Post-cycle final state
VERIFIED (total_attempt_count=2, replay_count=1). Intermediate
QUEUED/attempt_count=0 state immediately after replay: NOT CAPTURED --
the worker consumed the message before sequential manual psql commands
could observe it (worker claim-to-completion time was under 60ms in
every measured case this session).

### Test 2 -- Successful replay: PASS
Job dbf275f3-62bc-4f26-b979-a4054ff51594. Exhausted 5 attempts
naturally (DEAD_LETTERED, attempt_count=5, total_attempt_count=5).
Payload manually cleared, replayed: HTTP 200. Single clean post-replay
attempt (no retry) -> COMPLETED. Final: attempt_count=1,
total_attempt_count=6, replay_count=1, last_dead_lettered_at unchanged
from original exhaustion. RabbitMQ verified: main queue Ready=0/Unacked=0;
DLQ Ready=13 both before and after (unchanged).

Note: first attempt at this test failed due to a test-execution mistake
(an unsubstituted placeholder in the replay curl command caused the
command to never actually run) -- caught and corrected before
proceeding; documented here for honesty rather than omitted.

### Test 3 -- Retry after replay: PASS, including measured timing
Job 2c45f4f0-8d95-4fb8-ae9e-a02c99b6d00a. Original cycle exhausted
(5 attempts). Replayed WITHOUT clearing the failure condition -- worker
log confirmed "attempt":1 (not 6) on the first post-replay claim,
proving attempt_count genuinely reset. Full independent 5-attempt
backoff cycle re-ran:

Original cycle gaps: 2005ms/4006ms/8005ms/16005ms (scheduled
2000/4000/8000/16000)
Post-replay cycle gaps: 2005ms/4003ms/8005ms/16007ms (same schedule)

All 8 measured gaps within 3-7ms of calculated exponential backoff.
Second exhaustion -> DEAD_LETTERED again. Final: attempt_count=5,
total_attempt_count=10, replay_count=1 (unchanged by the second
exhaustion), last_dead_lettered_at updated to the second (most recent)
event.

### Test 4 -- Invalid replay states: PASS, all six cases
- DEAD_LETTERED -> 200 (real, multiple jobs)
- COMPLETED -> 409 (real, job 2ca21851..., naturally timed)
- QUEUED -> 409 (real, concurrent-replay loser, job 26a1f8db...)
- PROCESSING -> 409 (real request, against a state deterministically
  forced via direct SQL UPDATE -- job c45719ad...)
- RETRYING -> 409 (same method -- job 2c7351ec...)
- Nonexistent UUID -> 404 (real)
- Malformed UUID -> 400, both on POST /:id/replay and GET /:id (real)

### Test 5 -- Concurrent replay: VERIFIED (evidence reused, not re-run)
Per explicit instruction, this test was NOT re-executed during this
verification session. The result is based entirely on evidence
gathered during the earlier Phase 6 implementation session: job
26a1f8db-6822-4563-86e0-16e2e505ed60, two replay requests dispatched
5ms apart via a PowerShell Start-Job script, both reaching "Attempting
replay claim" 14ms apart, winner HTTP 200, loser HTTP 409 with
currentStatus="QUEUED" (the winner's post-state), final replay_count=1.

### Redelivery / failure-loop safety: PASS
Malformed/nonexistent UUID: confirmed structurally loop-proof (no
AMQP requeue mechanism on this HTTP-only path) plus real 400/404
responses already captured in Test 4.

Publish-failure scenario: REPRODUCED FOR REAL. See
incidents-and-failures.md, Deliberate Test 3 and Incident 5, for full
detail. Job 7c305a47-5624-4300-bce4-9db927538834 confirmed permanently
stuck in QUEUED even after RabbitMQ fully recovered -- a real,
concrete instance of the known DB/RabbitMQ dual-write limitation.

### Unplanned finding: Incident 5 -- API RabbitMQ channel-recovery gap
Discovered as a direct consequence of the publish-failure test above.
Root-caused via code inspection (not speculation): no event listeners
registered on the connection/channel, so no invalidation of the cached
channel reference occurs on disconnect. Full detail in
incidents-and-failures.md. NOT fixed this phase, per instruction.

### Phase 4/5 regression: PASS
Stale-PROCESSING reclaim (Phase 5) re-verified: job
91842b6d-0d41-4b6a-9f22-d34b83a76604, manually backdated to PROCESSING
with a 90s-stale updated_at, successfully reclaimed and completed by
the worker via the unmodified staleness branch of claimJob's WHERE
clause. Bonus: two subsequent claim attempts against the now-COMPLETED
job were both correctly rejected (currentStatus=COMPLETED),
re-confirming the terminal-state guard.

Note: this test's actual execution sequence (worker restart discovering
an already-queued message, rather than a fresh manual redelivery)
differed slightly from the originally planned script, due to the API
restart required by Incident 5 disrupting timing. The mechanism
exercised and the evidence obtained are still valid and directly
relevant -- documented honestly rather than presented as having gone
exactly to plan.

### Summary of known limitations carried forward or newly discovered
- total_attempt_count/replay_count are aggregate-only; no
  job_attempts table exists (by design, per project scope)
- DB/RabbitMQ dual-write gap: now confirmed on both job creation
  (Phase 2) and replay (Phase 6) paths; not solved, consistent with
  standing decision against implementing an outbox pattern
- API RabbitMQ channel does not auto-recover after broker restart
  (Incident 5, newly discovered this phase); manual restart required
- Basic replay's intermediate QUEUED state: NOT CAPTURED (observational
  limitation of manual sequential testing, not a functional gap)