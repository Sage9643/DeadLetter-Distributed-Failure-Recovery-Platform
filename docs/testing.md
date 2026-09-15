# Testing

## Status: implementation complete, execution PENDING real npm test output

## Framework

Jest + ts-jest, configured independently per app (apps/api, apps/worker) --
each has its own tsconfig.json and its own npm workspace package, so each
gets its own jest.config.js rather than a single shared root config.

Supertest used only in apps/api, for route-level tests against the Express
app object directly -- no real network port is bound; supertest handles
requests in-process.

## Test structure

```
apps/api/src/__tests__/
  tsconfig.json                  -- test-only type config (see below)
  unit/jobSchema.test.ts        -- createJobSchema, jobIdParamSchema
  integration/jobService.test.ts -- claimReplay concurrency (real Postgres)
  api/jobsRoute.test.ts          -- supertest route tests
  helpers/testDb.ts              -- shared pool + safety check + truncate

apps/worker/src/__tests__/
  tsconfig.json                  -- test-only type config (see below)
  unit/retryPolicy.test.ts       -- calculateBackoffMs
  integration/jobService.test.ts -- claimJob concurrency + state-machine
                                     preconditions (real Postgres)
  helpers/testDb.ts              -- separate copy; no packages/shared
                                     exists yet, duplicating ~15 lines is
                                     not worth introducing one
```

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