# Testing

## Status: real, passing (as of Phase 16's final audit)

(Corrected during the Phase 16 final audit -- this line previously
read "implementation complete, execution PENDING real npm test
output" and was stale from an early phase; real execution has existed
since Phase 12.)

Most recent real, **full** run (Phase 15 closeout, from the project
owner's own environment, with a live Postgres/RabbitMQ available): API
19/19 suites, 84/84 tests passed; Worker 6/6 suites, 23/23 tests
passed; combined 25/25 suites, 107/107 tests passed.

Phase 16 added 4 new test files: API `unit/auth.test.ts`,
`api/authRoute.test.ts`; worker `unit/markCompletedFailure.test.ts`,
`integration/idempotency.test.ts`. `npx jest --listTests` now reports
21 suites for API (up from 19) and 8 suites for worker (up from 6).

**Phase 17 addition -- a second, separate test runner for
non-Jest-scope scripts.** `apps/api/scripts/*.js` (the WebSocket/
latency/chaos production verification scripts) live outside apps/api's
Jest `src/__tests__` root by design (they are standalone operational
scripts, not part of the API application). Two of them have focused
regression tests using Node's own built-in test runner
(`node:test`/`node:assert`) rather than being pulled into Jest's
config for a couple of pure functions:
`apps/api/scripts/__tests__/extractJobId.test.js` (3 tests) and
`apps/api/scripts/__tests__/composeCommand.test.js` (4 tests). Run
with:
```
node --test 'apps/api/scripts/__tests__/*.test.js'
```
Real, verified: 7/7 passed (both files run together, confirming no
interference). These are NOT counted in the Jest suite/test totals
above -- a different runner, a different directory, tracked here
separately.

**Real, verified evidence for Phase 16's own change set specifically**
(run from this session's device-bridge shell, which has no reachable
Postgres/RabbitMQ -- see `docs/engineering-decisions.md` -- so only the
DB/broker-independent unit suites could be run here):

- API `src/__tests__/unit/*`: **7/7 suites, 40/40 tests passed**,
  including the new `auth.test.ts` (5 tests).
- Worker `src/__tests__/unit/*`: **6/6 suites, 19/19 tests passed**,
  including the new `markCompletedFailure.test.ts` (3/3 -- the
  verified proof of the Phase 16 worker-completion-race fix in
  `consumer.ts`) and the pre-existing `dbErrorBackoff.test.ts`
  regression guard, still green.

**Not yet confirmed from a real run:** the 3 DB-dependent suites added
or exercised by Phase 16 -- API's `api/authRoute.test.ts` and
worker's `integration/idempotency.test.ts` (both need a live Postgres)
-- plus a fresh full combined count across both apps including
everything above. These require the project owner's own environment,
exactly like the Phase 15 full-suite run did; see
`docs/development-log.md`, Phase 16, for whether that has happened by
the time you're reading this.

## Framework

Jest + ts-jest, configured independently per app (apps/api, apps/worker) --
each has its own tsconfig.json and its own npm workspace package, so each
gets its own jest.config.js rather than a single shared root config.

Supertest used only in apps/api, for route-level tests against the Express
app object directly -- no real network port is bound; supertest handles
requests in-process.

## Test structure

(Corrected during the Phase 16 final audit -- the listing below was a
Phase-1-era snapshot of 4-5 files per app, never refreshed as dozens
of test files were added across Phases 5-16. This is now the real,
complete list, grouped by kind rather than narrated file-by-file.)

```
apps/api/src/__tests__/            (23 files, 21 suites -- some files
                                     are shared helpers, not suites)
  tsconfig.json                    -- test-only type config (see below)
  helpers/testDb.ts                -- shared pool + safety check + truncate
  unit/                            -- 7 files: jobSchema, rateLimiter
                                     (+ concurrency variant), broadcaster,
                                     connectionRecovery (Phase 14),
                                     poolErrorHandling (Phase 15),
                                     auth (Phase 16 -- requireApiKey
                                     middleware, mocked env)
  integration/                     -- 10 files: jobService, listRecentJobs,
                                     changeDetector, statsService,
                                     backpressure, rateLimiterRoute,
                                     outboxService, outboxTransaction
                                     (Phase 10), dispatcher (Phase 10),
                                     wsServer
  api/                             -- 4 files: supertest route tests
                                     (jobsRoute, jobsListRoute, healthRoute,
                                     authRoute (Phase 16 -- full route-level
                                     auth gating, real Postgres))

apps/worker/src/__tests__/         (10 files, 8 suites -- tsconfig.json
                                     and helpers/testDb.ts are not suites)
  tsconfig.json                    -- test-only type config (see below)
  helpers/testDb.ts                -- separate copy; no packages/shared
                                     exists yet, duplicating ~15 lines is
                                     not worth introducing one
  unit/                            -- 6 files: retryPolicy,
                                     connectionRecovery + consumerResubscribe
                                     (Phase 14), poolErrorHandling +
                                     dbErrorBackoff (Phase 15),
                                     markCompletedFailure (Phase 16)
  integration/                     -- 2 files: jobService (claimJob
                                     concurrency + state-machine
                                     preconditions, real Postgres),
                                     idempotency (Phase 16 -- duplicate-
                                     delivery-is-safe proof, real Postgres)
```

The exact, current file list is always authoritative over this
summary -- see each app's `src/__tests__/` directory directly.

Colocated under each app's src/ rather than the top-level tests/
scaffolding from Phase 0, since each app needs an independently configured
Jest/ts-jest instance against its own tsconfig.

## Test-only TypeScript config

The main tsconfig.json (production build config, used by `npm run build`
and `npm run dev`) sets `"types": ["node"]` explicitly, a deliberate
Phase 1 fix (see incidents-and-failures.md, Incident 1) for a
verbatimModuleSyntax conflict. Because `types` is explicitly listed,
`@types/jest`'s global declarations (`describe`, `it`, `expect`, etc.)
are excluded even though the package is installed.

Rather than adding "jest" to the main tsconfig.json (real production
config, not something to alter for a test-only need), each app has a
small `src/__tests__/tsconfig.json` extending the main config and adding
only `"jest"` to `types`. This is picked up automatically by editors
(TypeScript/VSCode always resolve the NEAREST tsconfig.json to a given
file) and is explicitly wired into ts-jest via jest.config.js's
`transform` option, so editor type-checking and actual `npm test`
compilation behave consistently. The production tsconfig.json is not
modified.

## Test database

A second logical database, `deadletter_test`, inside the SAME already-
running PostgreSQL container -- not new infrastructure.

Created via a one-time manual command (documented, not automated -- see
engineering-decisions.md for why automatic creation was assessed and
rejected as disproportionate complexity for a one-time bootstrap step):

```
docker exec -it deadletter-postgres psql -U deadletter -d deadletter -c "CREATE DATABASE deadletter_test;"
type infra\init-db\001_create_jobs_table.sql | docker exec -i deadletter-postgres psql -U deadletter -d deadletter_test
type infra\init-db\002_phase6_replay_columns.sql | docker exec -i deadletter-postgres psql -U deadletter -d deadletter_test
```

Applied and verified via `\d jobs` against deadletter_test: all 13
columns present, matching the dev database schema exactly. The dev
`deadletter` database itself was never altered by this process.

**Note added in Phase 13:** this same three-command sequence (plus the
Phase 10 `003_phase10_outbox_table.sql` migration, added after this
section was originally written) is now also run automatically, against
a fresh PostgreSQL service container, by `.github/workflows/ci.yml` on
every push/PR -- see architecture.md's CI/CD section. That workflow
reuses these exact commands rather than introducing a separate
migration mechanism; this manual sequence remains the correct way to
set up `deadletter_test` for local development.

**Superseded in Phase 17:** the manual per-file `psql`-piping sequence
above is the *original* bootstrap method and is kept here as historical
record, but it is no longer how this project actually applies schema
changes anywhere. `apps/api/src/scripts/migrate.ts` (a small,
project-owned migration runner -- not a new framework/ORM dependency)
replaced it everywhere: `.github/workflows/ci.yml` now runs it instead
of piping the three `.sql` files by hand, and
`infra/docker-compose.prod.yml` runs it as a `migrate` service before
`api`/`worker` are allowed to start. The reason: the old
`docker-entrypoint-initdb.d` auto-init mechanism (and, equivalently,
"remember to run the new file by hand") only ever covers a *fresh*,
empty database -- this project's own history has two real incidents of
a schema change needing to be applied by hand against an
already-populated volume (see docs/database.md, Phase 6 and Phase 10
entries) because nothing else would have applied it. The current,
correct way to create and populate `deadletter_test` locally is:

```
docker exec -it deadletter-postgres psql -U deadletter -d deadletter -c "CREATE DATABASE deadletter_test;"
cd apps/api
$env:DATABASE_URL="postgresql://deadletter:deadletter_dev_password@localhost:5432/deadletter_test"; $env:MIGRATIONS_DIR="../../infra/migrations"; npm run migrate
```

(PowerShell syntax for the two environment variables, matching this
project's real Windows development environment; the equivalent in bash
is `DATABASE_URL=... MIGRATIONS_DIR=... npm run migrate`.) This is
idempotent -- safe to re-run any time a new migration file is added,
against either a brand new or an already-populated `deadletter_test`.
See docs/deployment.md for the full migration runner design and its
production usage.

## Test database safety

Two independent layers:

1. **Env-loading layer:** Jest's `setupFiles` loads `.env.test` before any
   test module's own `import "dotenv/config"` executes. dotenv never
   overrides an already-set `process.env` value, so `.env.test`'s
   DATABASE_URL wins and the dev `.env`'s value is silently skipped for
   the entire test process.
2. **Runtime layer (the actual guarantee):** `assertTestDatabase()` queries
   `SELECT current_database()` -- asking Postgres itself, not trusting any
   config string -- before any TRUNCATE. Throws immediately if the
   connected database is not exactly `deadletter_test`.

`.env.test` is committed to the repository (unlike `.env`, which is
gitignored) because it contains only the same non-secret local
docker-compose credentials already visible in the committed
docker-compose.yml -- not a real secret, and necessary for anyone cloning
the repo to run tests immediately.

## Isolation strategy -- why truncate, not transactional rollback

The concurrency tests (claimJob, claimReplay) require two independent
Postgres connections to genuinely race against the SAME committed row.
Wrapping a test in an outer uncommitted transaction is incompatible with
this: each concurrent call still obtains its own connection from the pool,
and an uncommitted setup row would not even be visible to the "competing"
connection under Postgres's MVCC visibility rules. Truncate-between-tests
avoids this entirely at the cost of being somewhat slower than rollback-
based isolation -- an explicit, accepted tradeoff.

## Concurrency testing strategy

Phase 5 and Phase 6 proved these same atomic-claim guarantees manually,
using real multi-process/multi-terminal orchestration (two worker
processes, two HTTP requests fired via a PowerShell script) specifically
because a MANUAL test needs that to force genuine overlap.

An automated test does not have that constraint. `claimJob` and
`claimReplay` are plain exported async functions; firing two calls via
`Promise.all([claimJob(id), claimJob(id)])` against a real Postgres
connection genuinely executes them concurrently at the Node event-loop /
connection-pool level, and Postgres's row-level locking provides the exact
same atomicity guarantee -- provable directly via `expect()` assertions
instead of manually-diffed log timestamps. This is not a weaker
substitute for the Phase 5/6 manual proofs; it is a more deterministic,
repeatable reproduction of the same underlying database guarantee.

## Parallelism -- maxWorkers: 1

Jest runs test FILES in parallel worker processes by default. Since
multiple files TRUNCATE the same shared deadletter_test.jobs table,
parallel execution could let one file's truncate wipe another file's
fixtures mid-test. maxWorkers: 1 forces sequential file execution,
trading test-run speed for full determinism -- consistent with this
project's testing philosophy throughout Phases 2-6.

## API testing -- RabbitMQ mocking

`publishJobCreated` is mocked via `jest.mock()` in jobsRoute.test.ts, so
route tests never require a live RabbitMQ connection and never publish
real messages during test runs. The claimReplay/claimJob integration
tests also require no RabbitMQ, since neither function calls the
publisher internally -- only the route handlers do.

No real-publish integration test was added this phase (explicitly
optional per the approved design; deferred, not required for Phase 7
completion).

## Dependency note -- ts-jest / TypeScript 7

This project uses TypeScript 7.0.2 (see engineering-decisions.md for
prior notes on this being notably newer than typical training-data
expectations). ts-jest's published peerDependencies range
(">=4.3 <7") does not yet include TypeScript 7, but ts-jest 29.4.12's
own changelog confirms "support TypeScript 7 projects through
compatibility aliases" was added in that exact version -- a metadata
lag, not a genuine incompatibility. Installed with `--legacy-peer-deps`
to skip the stale peer-dependency check; verified working via actual
successful test runs (see development-log.md), not assumed from the
changelog alone.

## What these tests PROVE

- The claimJob concurrency test proves the PostgreSQL atomic claim
  guarantee: under genuine concurrent execution, exactly one caller
  receives a non-null row.
- The claimReplay concurrency test proves the equivalent guarantee for
  the DEAD_LETTERED -> QUEUED replay transition.
- The state-machine precondition tests prove markCompleted/markRetrying/
  markDeadLettered correctly refuse to mutate a job that is not in
  PROCESSING state.
- The API route tests prove the validation and state-machine rejection
  logic (400/404/409/200) at the HTTP layer.

## What these tests do NOT prove

- They do NOT prove exactly-once business-level side effects. Atomic
  claiming guarantees at most one caller wins the database claim; it
  says nothing about whether the job's actual processing logic (real
  side effects, e.g. sending an email) is itself idempotent. This
  remains a known limitation from Phase 5.
- They do NOT constitute full RabbitMQ or worker-process end-to-end
  testing. No test in this suite spawns a real worker process or
  exercises the actual message-consumption path; that remains covered
  only by the manual evidence recorded in Phases 2-6's documentation.
- They do NOT test retry/backoff timing precision (that was verified
  manually with real wall-clock measurements in Phases 4-6; automating
  a timing-sensitive test reliably was judged lower value than the
  concurrency tests for this phase's scope).

## How to run

```
cd apps\worker && npm test
cd apps\api && npm test
```

## Test execution results

**All tests passing, both apps, as of first real execution:**
apps/worker: Test Suites: 2 passed, 2 total | Tests: 11 passed, 11 total
apps/api: Test Suites: 3 passed, 3 total | Tests: 22 passed, 22 total


Total: 33 automated tests, 0 failures.

The API run's console output includes real, structured pino log lines
from the actual application code (not mocked) for every route test --
e.g. real "Malformed job id in GET request" / "Job not found" / "Replay
rejected -- job not in DEAD_LETTERED state" (with the correct
currentStatus for each of COMPLETED/PROCESSING/QUEUED/RETRYING) / "Replay
claim succeeded, publishing job.created message" entries -- confirming
supertest genuinely exercised the real Express route handlers and real
Postgres-backed service functions, not a simulated response.

## Real incident encountered during setup: TypeScript 7 / ts-jest incompatibility

**This project uses TypeScript 7.0.2** for its production build (`tsc`,
`npm run build`/`npm run dev`) since Phase 0. During Phase 7 setup, this
version proved genuinely incompatible with `ts-jest@29.4.12` for actual
test execution -- not merely a stale peer-dependency metadata issue as
initially suspected.

**What was tried and found NOT to work:**
1. `ts-jest`'s own changelog states "support TypeScript 7 projects
   through compatibility aliases" was added in 29.4.12. Installing with
   `--legacy-peer-deps` to bypass the stale `peerDependencies` range
   (`>=4.3 <7`) seemed reasonable given this. In practice, running the
   actual test suite against the real TypeScript 7.0.2 install failed
   immediately with: `The TypeScript compiler "typescript" (version
   7.0.2) does not expose the JavaScript compiler API required by
   ts-jest.`
2. Attempting to alias a classic TypeScript release
   (`typescript-for-jest@npm:typescript@5.7.3`) via `ts-jest`'s
   `compiler` config option progressed past that error but hit a
   second, different internal ts-jest error:
   `TypeError: Cannot read properties of undefined (reading 'Node16')`
   inside ts-jest's own TypeScript-7-compatibility detection code. This
   suggested the compatibility-alias code path itself was not yet
   reliable enough to build a test setup on.

**What actually worked, verified by real passing test runs:** pinning
BOTH apps' `typescript` devDependency to `6.0.3` (a pre-native-compiler
release with the full classic JS compiler API `ts-jest` expects), with
no special `ts-jest` configuration needed beyond pointing at the
test-only `tsconfig.json`. This was discovered somewhat by accident: the
worker's `npm install` (run without `--legacy-peer-deps`, unlike the
API's first attempt) resulted in npm silently nesting a workspace-local
`typescript@6.0.3` to satisfy `ts-jest`'s real requirement, and its
tests passed immediately and cleanly as a result -- which is what
revealed the correct fix once compared against the API's failing setup.

**Both apps now explicitly declare `"typescript": "^6.0.3"`** in their
respective `package.json` (not left as an incidental/accidental
resolution), verified via `npm ls typescript` showing a clean,
deduplicated resolution with no `invalid:` marker in both workspaces.

**Scope of this change, explicitly confirmed:** this affects ONLY the
TypeScript compiler version used for building and testing both apps.
No application source file outside `src/__tests__/` was modified as
part of this investigation -- confirmed via `git status` and `git diff`
against the Phase 6 commit (27272fd), showing consumer.ts, createJob(),
claimJob's WHERE clause, and the entire replay implementation as
completely unchanged. The production `tsconfig.json` changes are
limited to: removing an `exclude` array (needed once test files existed,
to protect `dist/` from being treated as compiler input -- a real
TypeScript behavior, not a choice, since providing any custom `exclude`
array replaces TypeScript's implicit default one that normally protects
`outDir` automatically) and the `noEmitOnError`/style-comma cleanup
incidental to that edit. No compilerOptions governing actual code
generation, module resolution, or type-checking strictness were changed.

This is documented as a real, encountered engineering problem -- not
smoothed over -- because it directly demonstrates why "the changelog
says X" is not equivalent to "verified working," a principle this
project has applied consistently since Phase 2's amqplib version check.
## Phase 14 -- first amqplib-mocked unit tests

Every prior test touching RabbitMQ (`dispatcher.test.ts`, the Phase 5
consumer/worker concurrency tests, etc.) runs against a real, healthy
broker -- consistent with this project's general preference for real
infrastructure over mocks. Phase 14's connection-recovery fix needed a
narrow, deliberate exception: the behavior under test is specifically
what happens when a connection/channel dies, which cannot be triggered
deterministically (or, from most environments, at all) against a real
broker inside a Jest run.

`apps/api/src/__tests__/unit/connectionRecovery.test.ts`,
`apps/worker/src/__tests__/unit/connectionRecovery.test.ts`, and
`apps/worker/src/__tests__/unit/consumerResubscribe.test.ts` each
`jest.mock("amqplib")` with a small `EventEmitter`-based fake
connection/channel, so a `'close'`/`'error'` event can be emitted
directly and the resulting reconnect/resubscribe behavior asserted
deterministically. See engineering-decisions.md's "unit-test the
reconnection logic against a mocked amqplib" decision for the full
reasoning, and incidents-and-failures.md's Phase 14 update on
Incident 8 for why a real chaos re-test was still separately needed --
these unit tests prove the logic is internally correct, not that the
whole system recovers against a genuine outage.

**Real execution result:** run for real on the user's Windows
environment, `apps/worker`'s suite (including both
`connectionRecovery.test.ts` and `consumerResubscribe.test.ts`) passed
4/4 suites, 15/15 tests -- after a test-only synchronization fix to
`consumerResubscribe.test.ts` (see development-log.md's Phase 14
addendum for the reproduction, root cause, fix and verification of
that test bug; the recovery implementation itself was not changed).
`apps/api`'s Jest suite (including `connectionRecovery.test.ts`) has
since also been run for real on the user's Windows environment: 18
suites passed, 82 tests passed. Separately, a real RabbitMQ chaos test
against the actual Docker Compose stack has now also been performed -- see
incidents-and-failures.md, Incident 8, and development-log.md's Phase
14 addendum -- providing the whole-system evidence these unit tests
were never meant to substitute for.

## Phase 15 -- mocked-"pg" unit tests

A `pg.Pool`'s background `"error"` event, and a sustained sequence of
DB-query failures, cannot be deterministically triggered against a
real, healthy `deadletter_test` database inside a Jest run -- the same
class of problem Phase 14 solved by mocking `amqplib` for its
connection-recovery tests.

`apps/api/src/__tests__/unit/poolErrorHandling.test.ts` and
`apps/worker/src/__tests__/unit/poolErrorHandling.test.ts` each
`jest.mock("pg")` with a small `EventEmitter`-based fake `Pool`, so a
background `"error"` event can be emitted directly and the absence of
`process.exit()` asserted deterministically (via a `process.exit` spy
that throws instead of actually exiting the Jest worker, turning a
regression into an ordinary failed assertion rather than a crashed test
run).

`apps/worker/src/__tests__/unit/dbErrorBackoff.test.ts` additionally
mocks `services/jobService`, `processors/jobProcessor`, and
`queue/retryPublisher` (on top of the same `amqplib` mock Phase 14
established), so each DB-error and business-failure branch of the
message handler can be driven deterministically -- asserting, using
`jest.useFakeTimers()`/`advanceTimersByTimeAsync` (the same technique
Phase 14's `consumerResubscribe.test.ts` used), that the first
consecutive DB error waits the base ~1s delay before NACKing, a second
consecutive error waits ~2s, a successful claim resets the counter
back to the base delay, and a business-logic failure (not a DB error)
is still ACKed immediately with no backoff at all. `computeDbErrorBackoffMs()`
is also exported from `consumer.ts` and tested directly as a pure
function for the 1s/2s/4s/8s/16s/30s-capped sequence, without needing
any timers or mocks at all for that part.

See `engineering-decisions.md`'s "mock the pg module" decision for the
full reasoning, and `incidents-and-failures.md`'s Incident 9 for the
real chaos re-test that was performed separately -- these unit tests
prove the logic is internally correct on their own; the whole-system
evidence that the fix survives a genuine, sustained Postgres outage
came from that real chaos test, not from these mocks.

**Real execution result:** confirmed from the user's own real
environment -- API: 19/19 suites passed, 84/84 tests passed; Worker:
6/6 suites passed, 23/23 tests passed (combined 25/25 suites, 107/107
tests), including all three of these new Phase 15 test files. This
session's own device-bridge shell still cannot execute Jest itself
(`Preset ts-jest not found relative to rootDir`, reconfirmed again
during this closeout) -- the real numbers above came from the user's
environment, exactly as reported, not from this session. Getting Jest
running for real also surfaced one small, related fix: both apps'
`jest.setup.js` now load `.env.test` with dotenv's `override: true`,
closing off the same class of stale-`DATABASE_URL`-shadowing risk
diagnosed earlier during this phase's chaos testing. Both the unit
tests and the system-level behavior they model are now independently
confirmed: the unit tests by this real Jest run, and the system
behavior by the real PostgreSQL chaos test (see `development-log.md`,
Phase 15, and `incidents-and-failures.md`, Incident 9).
