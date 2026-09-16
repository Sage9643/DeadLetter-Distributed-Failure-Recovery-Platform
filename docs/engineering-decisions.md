# Engineering Decisions

## Decision: Fail-fast environment variable validation

**Context:** The API depends on environment variables (database URL, port,
etc.) that could be missing or malformed, especially across different
environments (local dev, CI, production).

**Options considered:**
1. Read `process.env` directly wherever needed, trust it's correct.
2. Validate once at startup with a schema (Zod), fail immediately if
   invalid.

**Chosen approach:** Option 2 — a single `src/config/env.ts` module
validates all required environment variables at startup using Zod, and
exports a typed `env` object for the rest of the app to import.

**Why:** Option 1 defers failure to whenever the bad value is first used,
which could be mid-request, with a confusing error far from the actual
cause (e.g. `pg` throwing a cryptic connection error because
`DATABASE_URL` was `undefined`). Option 2 fails at process startup, with
a clear message naming exactly which variable is missing or invalid,
before the app ever accepts a request.

**Trade-offs:** Slightly more upfront code (one schema file) compared to
just reading `process.env.WHATEVER` inline. Considered negligible against
the debugging time saved.

**Consequences:** Every new environment variable the app needs must be
added to the Zod schema in `env.ts`, or it won't be available (TypeScript
will also correctly refuse to let us reference a property that isn't in
the schema, which is a feature, not friction).

## Decision: CommonJS over ESM for apps/api and apps/worker

**Context:** `tsc --init`'s modern defaults (`module: nodenext`,
`verbatimModuleSyntax: true`) assume the project is either explicitly
ESM or CommonJS, and error loudly if the `tsconfig.json` and
`package.json` disagree (see incidents-and-failures.md, Incident 1).

**Options considered:**
1. Convert to ESM (`"type": "module"` in package.json), requiring
   explicit `.js` extensions on relative imports and no `require()`
   anywhere.
2. Stay CommonJS (npm's default), align `tsconfig.json` to match.

**Chosen approach:** Option 2.

**Why:** This project's priority is a working, well-tested distributed
system — not showcasing ESM/CommonJS interop. CommonJS is still the
default and most common choice for Node/Express backends, has fewer
tooling surprises with commonly used libraries, and required no
package.json changes since it was already npm's default.

**Trade-offs:** Slightly "older-style" module system; some newer
ESM-only packages could theoretically require workarounds later. No
such conflict encountered so far.

**Consequences:** All future files in `apps/api` and `apps/worker` are
written and compiled as CommonJS. `packages/shared`, when introduced,
should follow the same convention for consistency.


## Open Decision: How to handle DB/RabbitMQ publish failure after a successful DB write

**Context:** Deliberate Test 2 (see incidents-and-failures.md) confirmed
that when PostgreSQL succeeds but the subsequent RabbitMQ publish fails
(e.g., broker unavailable), a job is left permanently stuck as `QUEUED`
with no worker ever notified, and no current mechanism to detect this.

**Status:** NOT YET DECIDED. Documenting real options now that evidence
exists, per the project's rule against solving this prematurely.

**Options under consideration:**

1. **Transactional outbox pattern** — write the job and an "outbox"
   record to Postgres in the same transaction; a separate process polls
   the outbox table and publishes to RabbitMQ, marking outbox rows as
   sent. Guarantees the DB write and the "intent to publish" are
   atomic; publishing itself becomes retryable and recoverable from the
   outbox table if it fails.
   - Trade-off: adds a new table, a new background process (or polling
     loop), and publish latency now depends on the outbox poller's
     interval rather than being immediate.

2. **Reconciliation job** — a periodic background job that queries for
   jobs stuck in `QUEUED` beyond some threshold with no corresponding
   activity, and re-publishes them.
   - Trade-off: simpler than an outbox, but introduces a detection
     delay (jobs are stuck until the reconciliation job runs), and
     still needs a way to know "this job was never actually published"
     vs. "this job is legitimately still waiting to be processed."

3. **Do nothing yet; return a clear error and let the client retry** —
   accept that publish failures are visible to the client (via a
   proper error response, not today's raw stack trace) and rely on the
   client to retry job submission.
   - Trade-off: pushes the reliability burden to API clients; doesn't
     protect against the case where the client doesn't retry, or
     assumes success.

**Why no decision yet:** This requires weighing added complexity
(outbox/reconciliation) against how much reliability this project
genuinely needs to demonstrate, and interacts with retry/DLQ design
(Phase 4) that hasn't been built yet. Revisiting once Phase 4's retry
architecture exists, since the two problems may share a solution shape
(both are fundamentally about "how do we recover work that got stuck").

**Immediate, uncontroversial fix (separate from the above, and worth
doing regardless):** centralized error-handling middleware in Express,
so unhandled errors return clean JSON responses instead of leaking raw
stack traces — this is a real bug independent of which consistency
strategy we eventually choose.


## Decision: ACK only after terminal DB write, not on message receipt

**Context:** When should the worker tell RabbitMQ a message is handled?

**Options considered:** (1) ACK immediately on receipt, (2) ACK after the
terminal status (COMPLETED/FAILED) is written to Postgres.

**Chosen approach:** Option 2.

**Why:** ACKing on receipt would mean a worker crash between receipt and
finishing the DB write loses no message from RabbitMQ's perspective, but
the job would be stuck at whatever status it was left in, with no
mechanism to notice. ACKing after the terminal write ties message removal
to actual completion of work, matching Postgres as source of truth.

**Trade-offs:** A crash after the terminal write but before ACK causes
redelivery of an already-completed job -- handled by the terminal-state
guard, which is explicitly NOT full idempotency (see failure-handling.md).

## Decision: Split ACK/NACK behavior by failure class

**Context:** Not all failures during message handling are the same kind.

**Chosen approach:** Infrastructure failures (DB unreachable while
fetching/marking PROCESSING) -> NACK + requeue, since nothing was
recorded and retry is safe. Business-logic failures (processJob throws)
-> record as FAILED in Postgres, then ACK, since FAILED is currently
terminal with no retry policy (Phase 4).

**Why:** Treating both the same would either lose track of infra hiccups
(if always ACKed) or infinitely redeliver permanently-failed jobs with no
DLQ to catch them (if always NACKed).

**Trade-offs:** NACK+requeue on DB errors has no backoff yet -- could
hot-loop under a sustained DB outage. Accepted as a known limitation
until Phase 4.

## Decision: Worker pool error handler uses structured logger, not console.error

**Context:** apps/api's pool.ts used console.error for pool-level errors.
Worker now has a real pino logger (previously installed, unused).

**Chosen approach:** apps/worker/src/logger.ts has no dependency on
db/pool.ts (it only imports config/env.ts). pool.ts imports logger.ts.
This one-directional dependency avoids any circular import while letting
pool.ts log through the same structured logger as the rest of the worker.

**Why:** Consistent structured logging across the whole worker process,
not just inside the consumer -- matters once logs need to be
correlated/searched together.


## Decision: TTL + Dead Letter Exchange for retry delay, not the delayed-message plugin

**Context:** RabbitMQ core has no built-in delayed redelivery. The
common alternative is the `rabbitmq_delayed_message_exchange` plugin.

**Options considered:** (1) enable the delayed-message plugin
(non-default, requires image/config changes), (2) native TTL + DLX
pattern using only default RabbitMQ capabilities.

**Chosen approach:** Option 2.

**Why:** Avoids adding new infrastructure/plugins per the project's
explicit constraint against unnecessary additions. The TTL+DLX pattern
is a well-established, native RabbitMQ technique requiring zero changes
to the Docker image already running since Phase 0.

**Trade-offs:** Per-message TTL expiry ordering is not strictly
guaranteed by RabbitMQ when messages in the same queue have different
TTLs (RabbitMQ only checks the queue head for expiry). Not expected to
matter at this project's scale; documented as a known limitation rather
than solved.

## Decision: Exponential backoff formula and constants

**Chosen approach:** `delayMs = min(2000 * 2^(attemptCount-1), 20000)`,
implemented as a pure function in retryPolicy.ts.

**Why:** Simple, predictable, easily testable locally (max ~30s total
wait across all retries before exhaustion with default max_attempts=5).
No new environment variables introduced -- constants are code, not
config, since they don't need to vary per-environment yet.

## Decision: NonRetryableError for retryable vs terminal classification

**Context:** Not all processing failures should be retried -- e.g., a
permanently invalid job type is pointless to retry 5 times with backoff.

**Chosen approach:** A dedicated `NonRetryableError` class. Processors
throw it to signal immediate dead-lettering; any other thrown error is
treated as retryable by default.

**Why:** Explicit opt-in to "don't retry" via error type is simple,
type-checkable (`instanceof`), and doesn't require every processor to
manage attempt-counting logic itself -- that stays centralized in the
consumer.

**Trade-offs:** Currently binary (retryable or not) -- no support yet
for per-error-type custom backoff or retry limits. Sufficient for
current scope.

## Decision: Retire FAILED as a worker-written terminal status

**Context:** Phase 3 introduced FAILED as terminal. Phase 4's entire
purpose is ensuring a failure is never simply terminal without either a
retry attempt or explicit dead-lettering.

**Chosen approach:** The worker no longer writes FAILED. Every failure
now resolves to RETRYING or DEAD_LETTERED. FAILED remains valid in the
schema (existing Phase 3 rows, like the phase3_failure_test job, keep
their historical status) and is still checked defensively in the
terminal-state guard.

**Why:** This is a genuinely required behavior change (not incidental)
-- Phase 3's FAILED was correct for that phase's scope (no retry policy
existed), but is superseded now that one does.

## Decision: max_attempts remains fixed at schema default, not yet API-configurable

**Context:** Testing DLQ-via-exhaustion requires waiting through all
retries (~30s with defaults). A per-job override could speed this up.

**Chosen approach:** Deferred. Not implemented this phase.

**Why:** Adding this touches the API's validation schema and job
creation flow, which is out of this phase's stated scope (retry/DLQ is
worker-internal). The non-retryable test hook
(payload.shouldFailPermanently) already provides a fast way to exercise
the DLQ path without waiting, making this addition non-essential right
now.


## Correction: CLAIM_TEST_DELAY_MS replaced with CLAIM_TEST_SYNC_EPOCH_MS before execution

**Context:** Pre-execution review of the Test 4 concurrency-race
procedure found that a fixed relative delay (applied independently per
message, from each message's own arrival time) does not guarantee two
independent worker processes' claim attempts land close enough in time
to constitute a genuine race -- if the two messages are delivered even
a few seconds apart (realistic given manual test setup via the RabbitMQ
UI), the delay only guarantees sequential-but-nearby claims, not
overlapping ones.

**Chosen approach:** Replaced with an absolute shared target timestamp
(CLAIM_TEST_SYNC_EPOCH_MS). Both worker processes sleep until the same
wall-clock instant before attempting their claim, regardless of when
each actually received its message -- converging both attempts to
within milliseconds of each other at the point they call claimJob(),
which is genuine evidence of contention at the database layer, not
merely temporal proximity in application logs.

**Why:** This is the smallest change that closes the determinism gap
without touching claimJob() or any production correctness code -- it
is purely a test-harness mechanism.

**Trade-off:** Requires computing and manually distributing a shared
timestamp value across terminals for the test, slightly more setup than
a single relative delay. Accepted, since correctness of the evidence
matters more than test-setup convenience.

## Correction: Test 3 reframed -- prefetch(1) prevents a single-worker "duplicate while PROCESSING" test

**Context:** The original Test 3 (single worker, duplicate published
while the first message is mid-delay) does not actually exercise a
concurrent PROCESSING-state race. With prefetch(1) and one consumer,
RabbitMQ will not deliver a second message to that consumer until the
first is acknowledged -- so by the time the duplicate is delivered, the
original job has already reached a terminal state (COMPLETED). Test 3
was silently testing terminal-exclusion, not a live race.

**Resolution:** Test 3 is reframed honestly as "duplicate delivery
after the job is already COMPLETED" -- a legitimate, useful, but
different guarantee. Genuinely testing a duplicate against an actively
PROCESSING (not yet terminal) job requires >= 2 concurrent consumers,
which only Test 4 provides. Test 4 is now the sole test responsible for
proving the core concurrency-race guarantee.


## Decision: Replay attempt semantics -- reset attempt_count, add total_attempt_count and replay_count

**Context:** Phase 4's retry/exhaustion logic (attempt_count >=
max_attempts) needs to work correctly after a job is replayed, while
the project also requires not silently erasing failure history.

**Options considered:** (A) reset attempt_count to 0 only, (B) preserve
attempt_count cumulatively across replays, (C) reset attempt_count
per-cycle AND add a separate never-reset lifetime counter.

**Chosen approach:** C.

**Why:** B is a genuine correctness bug (see failure-handling.md for
the exact failure mode), not a valid alternative -- it would cause a
replayed job to dead-letter on its very first post-replay attempt with
zero retries, since the exhaustion check compares against the already-
maxed cumulative count. A alone loses the lifetime-attempts fact
entirely. C is the smallest design that is both correct (verified: job
6d0addf3... shows attempt:1, not 6, after replay) and non-lossy
(verified: job 03a4cfcd... shows total_attempt_count=6 after replay-to-
success).

**Trade-offs:** total_attempt_count is aggregate only -- no per-attempt
detail (timestamps, individual errors) without a job_attempts table,
which was deliberately not introduced this phase to keep the change
minimal.

## Decision: DLQ messages are not removed on replay

**Context:** Should replay attempt to consume/remove the corresponding
message from deadletter.jobs.dlq?

**Options considered:** (1) consume and remove the specific DLQ
message, (2) leave PostgreSQL as sole authority, leave the DLQ message
untouched.

**Chosen approach:** 2.

**Why:** AMQP queues are not queryable/addressable by content -- there
is no way to "remove message X" from a queue without consuming
(and re-publishing everything else) or using the RabbitMQ Management
API, both explicitly disallowed as unnecessary infrastructure for this
phase. Option 2 requires zero new infrastructure and directly extends
the project's standing Phase 0 principle that PostgreSQL, not RabbitMQ,
is authoritative for job state.

**Trade-off, explicitly accepted and verified:** the DLQ's Ready count
never decreases due to replay, even after a replayed job succeeds.
Confirmed real: Ready=10 in deadletter.jobs.dlq, unchanged after job
03a4cfcd... reached COMPLETED via replay. This must not be mistaken for
a bug -- it is the direct, intended consequence of this decision.

## Decision: Duplicate replay protection reuses Phase 5's atomic-claim pattern exactly

**Context:** Two concurrent replay requests for the same job must not
both succeed.

**Chosen approach:** A single atomic conditional UPDATE (claimReplay),
structurally identical in shape to Phase 5's claimJob -- WHERE
status='DEAD_LETTERED', no preliminary SELECT.

**Why:** Reuses an already-proven correctness pattern rather than
inventing a new mechanism. No Redis or other distributed lock needed,
consistent with the project's standing constraint.

**Verification:** Genuine concurrent race reproduced via two HTTP
requests fired 5ms apart, both delayed identically (REPLAY_TEST_DELAY_MS,
test-only) to force overlap at the actual claim. Claim attempts landed
14ms apart; the loser's observed currentStatus was QUEUED (the winner's
post-state), not a stale DEAD_LETTERED read -- proving real contention,
not a sequential near-miss. Final replay_count=1 confirms only one
UPDATE committed.

## Decision: RETRYING jobs are not replayable

**Context:** Should an already-RETRYING job be eligible for manual
replay?

**Chosen approach:** No -- rejected with 409, same as any other
non-DEAD_LETTERED status.

**Why:** A RETRYING job already has an automatic TTL-based retry
scheduled through the existing RabbitMQ retry queue (Phase 4). Allowing
a manual replay to run concurrently would race a manual message against
the automatic one, adding complexity for no real benefit -- the job is
already on a path toward its own outcome.

**Trade-off:** No way to "skip ahead" of a pending backoff wait via
replay. Considered a minor, acceptable UX limitation, not a correctness
gap.

## Decision: UUID format validation added to GET /:id and POST /:id/replay

**Context:** Incident 4 (Phase 5) showed that an invalid UUID reaching
PostgreSQL raises error code 22P02, which -- if unhandled -- surfaces
as a raw, unhandled 500 with a leaked stack trace.

**Chosen approach:** A shared Zod schema (jobIdParamSchema) validates
:id as UUID-format before either route queries the database, returning
a clean 400 instead.

**Why:** Directly closes the same error class Incident 4 already
identified, now on the API side rather than just the worker side.
Minimal, targeted fix -- no broader error-handling redesign attempted
this phase (that gap, first flagged in Phase 2's Deliberate Test 2,
remains open and tracked, not solved here).

**Verification:** Real request to POST /api/jobs/not-a-uuid/replay and
GET /api/jobs/not-a-uuid both returned 400 {"error":"Invalid job id
format"}.


## Addendum: Phase 6 decisions confirmed correct under real verification

All Phase 6 engineering decisions (attempt semantics Option C, DLQ
messages left untouched, duplicate-replay protection reusing Phase 5's
atomic pattern, RETRYING rejected) were subsequently verified against
real execution -- see failure-handling.md and development-log.md for
full evidence. No decision required revision as a result of
verification; two additional limitations were discovered during
verification itself (see incidents-and-failures.md): the DB/RabbitMQ
dual-write gap applying to the replay path (expected, consistent with
the already-known Phase 0/2 limitation, not a new decision) and the API
RabbitMQ channel-recovery gap (a newly discovered, separate limitation,
not previously documented).


## Decision: Pin TypeScript to 6.0.3 for both apps, superseding the earlier ts-jest/TS7 workaround attempts

**Context:** This project used TypeScript 7.0.2 since Phase 0. Phase 7's
introduction of Jest/ts-jest revealed this version does not expose the
classic JavaScript compiler API ts-jest requires for type-checked test
transformation -- confirmed by two independently failing workaround
attempts (see docs/testing.md for full detail), not merely a stale
peer-dependency metadata issue as first suspected from ts-jest's
changelog alone.

**Options considered:** (1) `--legacy-peer-deps` to bypass the peer
dependency check and use TypeScript 7 as-is, (2) alias a classic
TypeScript release specifically for ts-jest via its `compiler` config
option while keeping TypeScript 7 as the main devDependency, (3) pin
both apps' actual `typescript` devDependency to a classic release
(6.0.3) outright.

**Chosen approach:** Option 3.

**Why:** Options 1 and 2 were both tried first and both failed with
real, different errors during actual test execution -- not assumptions,
verified failures. Option 3 was discovered to already work by accident
for the worker workspace (npm's resolver had nested a working
`typescript@6.0.3` there without an explicit request), and once
identified, was applied deliberately and explicitly to both apps.

**Why 6.0.3 is safe for production code:** nothing implemented across
Phases 0-7 uses any TypeScript-7-specific language feature -- all
application code uses standard TypeScript syntax that has behaved
identically across major versions. This is purely a build-tooling
version change, not an application-logic


## Decision: /api/stats queries PostgreSQL only, never RabbitMQ

**Context:** Operational stats could include RabbitMQ queue depth
(literal AMQP Ready count) alongside PostgreSQL-derived job counts.

**Chosen approach:** PostgreSQL only. QUEUED/RETRYING counts serve as
an honest proxy for "work waiting."

**Why:** Querying RabbitMQ's management HTTP API would introduce a
second protocol/port coupling (management API on 15672, distinct from
the AMQP connection already in use on 5672) purely for an
observability endpoint, and a new failure mode for /api/stats itself.
Consistent with the same reasoning that rejected RabbitMQ management
API access for DLQ inspection in Phase 6.

**Trade-off:** /api/stats cannot report literal in-flight AMQP message
counts (e.g. messages currently sitting in the retry queue mid-backoff).
Accepted -- PostgreSQL's QUEUED/RETRYING counts are close enough for
operational visibility purposes and require no new coupling.

## Decision: separate liveness (/api/health) and readiness (/api/health/ready) endpoints

**Context:** The existing /api/health performed no dependency checks at
all. Incident 5 (Phase 6) showed a real scenario -- a dead RabbitMQ
channel after a broker restart -- invisible to any existing endpoint.

**Chosen approach:** Keep /api/health as pure liveness (unchanged
behavior). Add /api/health/ready performing real checks: PostgreSQL
SELECT 1, RabbitMQ channel.checkQueue() (read-only, idempotent, against
the already-asserted main queue -- no new topology).

**Why:** Liveness and readiness answer genuinely different questions
("is the process running" vs "can it actually do its job right now"),
and conflating them would make liveness checks (often used by
process supervisors to decide whether to restart a process) fire on
transient dependency issues that don't actually require a process
restart. Keeping them separate lets each be used for its correct
purpose.

**Explicitly NOT a fix for Incident 5:** the RabbitMQ channel still
does not auto-recover; a 503 from this endpoint would still require a
manual API restart to actually resolve, exactly as Incident 5
documented. This endpoint only makes that broken state detectable
instead of silent.

## Decision: processing duration is log-level per-attempt only, not a persisted aggregate metric

**Context:** The Phase 8 brief asked for processing latency where
"accurately derivable." The existing schema's updated_at is overwritten
on every status transition.

**Chosen approach:** Capture a duration in-process (Date.now() at claim,
delta at outcome) and include it in the existing structured log lines
only. No new column, no aggregate/average exposed via /api/stats.

**Why:** An aggregate latency metric computed from updated_at would be
inaccurate for any retried job (only reflects the latest transition),
and fabricating an average from inaccurate per-job data would violate
the project's standing rule against fabricated metrics. The per-attempt
log-level duration is genuinely accurate for what it measures (one
attempt's processing time) and requires no schema change.

**Trade-off:** No dashboard-ready aggregate latency number exists yet.
Would require a job_attempts table (same limitation documented since
Phase 1/6) to compute honestly at the aggregate level -- not introduced
this phase to avoid unnecessary schema complexity for a metric that
cannot yet be computed accurately.

## Decision: correlation ID propagation through RabbitMQ remains out of scope

**Context:** Phase 8 asked which worker log fields materially improve
debugging; correlation IDs threading an API request through to worker
logs was considered.

**Chosen approach:** Not implemented. The thin {jobId} RabbitMQ message
design (Phase 2) is preserved completely unchanged -- no new field
added to the message payload.

**Why:** jobId itself already provides real cross-process correlation
(the same jobId appears in both API and worker structured logs,
searchable identically to a dedicated correlation ID) without touching
the message schema. Adding a distinct correlation ID would require
either widening the thin-message contract Phase 2 deliberately chose,
or deriving one from jobId anyway -- providing no practical benefit
over using jobId directly. Explicitly a deliberate non-goal, not an
oversight.


## Decision: API polls PostgreSQL for change detection, rather than worker-push

**Context:** Job state changes originate in two separate processes
(worker: claimJob/markCompleted/markRetrying/markDeadLettered; API:
claimReplay). Both need to reach WebSocket-connected dashboard clients,
which only the API process manages.

**Options considered:** (1) worker pushes an HTTP notification to an
internal API endpoint after each terminal transition, (2) the API
independently polls PostgreSQL for recent changes.

**Chosen approach:** Option 2.

**Why:** Option 1 requires touching consumer.ts (a network call after
each of the four terminal log points, needing careful fire-and-forget
handling so a slow/down API never affects ACK/NACK timing or retry
correctness) and creates a new runtime coupling where worker
reliability becomes entangled with API/dashboard availability --
mirroring exactly the fragile inter-process coupling Incident 5 (Phase
6) already demonstrated causes real, hard-to-detect breakage. Option 2
requires zero worker changes (confirmed via git diff against 7ae6feea:
consumer.ts and worker's jobService.ts are completely absent from the
Phase 9 diff) and uniformly catches changes from ANY write path,
because it watches the actual source of truth rather than
instrumenting every individual call site.

**Trade-off:** Near-real-time (2s bound) rather than instant push;
intermediate rapid transitions within one interval are not individually
broadcast. Explicitly acceptable -- the mandated WS-as-notification-only
semantics never required instant delivery, only eventual, recoverable
notification.

## Decision: startup cursor via SELECT now(), not a default/historical timestamp

**Context:** Approval feedback identified a real startup race: an
in-memory cursor initialized to an old default would broadcast the
entire historical jobs table on API boot; initializing it naively
during startup could also create a window where an update is missed.

**Chosen approach:** `SELECT now()` executed against PostgreSQL itself,
as the literal first action before the poll interval begins -- see
apps/api/src/db/changeDetector.ts's getStartupCursor().

**Why:** Since the cursor IS the first thing established (one atomic
query, no gap between "cursor set" and "polling begins" in which an
update could slip through unaccounted-for), and every subsequent query
is strictly `WHERE updated_at > cursor`, both failure modes are
structurally avoided without a persistent event table or any new
infrastructure. Verified via 3 real integration tests against
deadletter_test (see changeDetector.test.ts): pre-existing jobs are
never broadcast on a fresh cursor, and jobs updated after a cursor was
established are always caught.

**Trade-off, explicitly accepted:** a job updated at the exact same
microsecond as the cursor could theoretically be skipped once. Not
engineered around further -- REST remains authoritative, so this
produces at most a temporarily stale dashboard, never an incorrect one.

## Decision: separate app.ts (route registration) from index.ts (process bootstrap)

**Context:** Where should the WebSocket server, poller, and graceful
shutdown live -- inside app.ts (where routes are registered) or
index.ts (where the process actually starts)?

**Chosen approach:** Entirely in index.ts. app.ts remains a pure
route-registration module with zero side effects, exactly as it was
before Phase 9.

**Why:** All 38 API tests import `app` directly via supertest, which
creates its own ephemeral server around the plain Express app
regardless of index.ts. If the WebSocket server or the 2-second poller
interval were started as a side effect of importing app.ts, every test
run would spin up a real timer/socket server it doesn't need, risking
Jest open-handle warnings or flakiness. Confirmed structurally correct
via git diff: app.ts shows zero changes against the Phase 8 commit.

## Decision: dev-tooling npm audit findings (vitest/vite/esbuild) accepted, not force-upgraded

**Context:** `npm install` in apps/dashboard reported 5 vulnerabilities
(3 moderate, 1 high, 1 critical) via `npm audit`.

**Investigated finding:** Both root advisories (@vitest/mocker path
traversal, esbuild dev-server request handling) are exposures in the
LOCAL DEVELOPMENT SERVER only -- a malicious website tricking a
running `vite dev`/`vitest` process into leaking files or accepting
requests. Neither affects the production `dist/` bundle actually
shipped, and neither is reachable outside an actively-running local
dev process.

**Chosen approach:** Not run `npm audit fix --force` this phase. The
fix would install vitest@5.0.1 and vite@8.x -- both unverified major
version bumps against this project's actual test/config setup, the
same category of blind-upgrade risk that caused real breakage in Phase
7's ts-jest incident.

**Why:** A verified, understood, dev-tooling-only exposure documented
honestly is preferable to an unverified major-version force-upgrade
applied reflexively mid-phase. Flagged as a genuine future task (verify
vite 8.x/vitest 5.x compatibility with this project's config, then
upgrade deliberately), not silently ignored or deferred without
tracking.


## Decision: Transactional outbox chosen over a reconciliation-only approach

**Context:** Phase 2's original tracked options for the DB/RabbitMQ
dual-write gap included a "reconciliation job" (periodically republish
stale-QUEUED jobs, no new table) alongside the transactional outbox,
with no decision made at the time.

**Chosen approach:** Transactional outbox (this phase).

**Why, specifically:** A reconciliation-only approach was rejected for
a concrete, structural reason still true today: a plain QUEUED job with
NO outbox table is genuinely indistinguishable from "never published"
vs. "published, just not yet consumed because workers are busy." A
staleness-only sweep cannot tell these apart without either risking
false-positive republishes of jobs that were already correctly
delivered, or accepting an unacceptably long detection delay to be
safe. An outbox row's binary published_at IS NULL state removes this
ambiguity entirely -- this is the outbox's specific, structural
advantage over reconciliation-only, not a default/conventional choice.

**Trade-off:** A new table, a new background poller (mirroring the
already-established Phase 9 change-poller pattern, so no new
architectural shape). No new infrastructure/service required.

## Decision: Job/outbox transaction boundary excludes the RabbitMQ publish itself

**Context:** Where should the transaction boundary sit -- around just
the DB writes, or held open through the RabbitMQ publish too?

**Chosen approach:** The transaction covers ONLY the job write + the
outbox_events insert. The RabbitMQ publish happens later, in the
dispatcher, entirely outside any open PostgreSQL transaction.

**Why:** Holding a DB transaction open across a network call to
RabbitMQ would mean a slow or hanging RabbitMQ directly stalls a
PostgreSQL connection/lock for an unbounded time -- a real production
risk (connection pool exhaustion under sustained RabbitMQ slowness),
not a hypothetical one. Separating them means the DB write commits fast
regardless of RabbitMQ's state, and the API's response time to the
client no longer depends on RabbitMQ being reachable at all -- proven
real during the deliberate outage test (POST /api/jobs returned a clean
201 with RabbitMQ fully down).

**Trade-off:** This is precisely what makes the outbox NOT
exactly-once (see failure-handling.md) -- the publish and the
"mark published" write are two separate operations with their own
(much smaller, still real) gap. Accepted, and structurally unavoidable
without holding a lock across network I/O, which was rejected as worse.

## Decision: Dispatcher claim uses SKIP LOCKED, not an application-level mutex

**Context:** How should concurrent dispatcher instances (relevant if
the API is ever horizontally scaled) avoid claiming and double-
publishing the same outbox row?

**Chosen approach:** `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE
SKIP LOCKED) RETURNING *` -- a single atomic SQL statement, the same
pattern family as Phase 5's claimJob and Phase 6's claimReplay.

**Why:** FOR UPDATE SKIP LOCKED is PostgreSQL's native mechanism for
exactly this "multiple workers competing for a queue of rows" pattern
-- any concurrent claim attempt against an already-locked row is
skipped rather than blocked, so two dispatchers can never both receive
the same row, with zero new infrastructure (no Redis lock, no
application-level mutex). Verified real via a genuine PostgreSQL
concurrency test (Promise.all against real deadletter_test, same
evidentiary standard as Phase 5/6's claim concurrency tests): two
concurrent claim calls against 4 pending rows never returned
overlapping IDs.

**Trade-off:** None significant at this project's current scale (single
API process). The mechanism is correct regardless of whether horizontal
scaling is ever introduced later.