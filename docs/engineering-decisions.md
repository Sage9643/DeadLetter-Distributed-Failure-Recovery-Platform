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
until Phase 4. **Update (Phase 15):** addressed with a capped local
backoff -- see the new Phase 15 decisions below and
`docs/incidents-and-failures.md`'s Phase 15 entry for the current,
honest validation status.

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

**Explicitly NOT a fix for Incident 5:** the RabbitMQ channel's
auto-recovery behavior is unchanged by this endpoint either way. Two
real chaos-test executions disagree on whether a stale channel actually
requires a manual API restart to resolve: the first did, the second
(authoritative, real Docker Compose) did not -- see
incidents-and-failures.md, Incident 8, "Update," for the open question
this leaves. This endpoint only makes the broken/recovering state
detectable instead of silent; it does not itself fix or guarantee
either recovery outcome.

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

## Decision: in-memory token bucket, not Redis, for Phase 12 rate limiting

**Context:** Rate limiting needs somewhere to store per-client request
counts. Redis is the conventional choice for a rate limiter meant to
work across multiple API instances.

**Chosen approach:** A plain in-memory `Map<string, Bucket>` inside the
single running API process.

**Why:** This project has never run more than one API instance (no
horizontal scaling anywhere in Phases 0-11, no load balancer, no
process manager configured for multiple workers). Redis would be new
infrastructure -- a new service to run, monitor, and reason about --
solving a scaling problem that does not exist yet. "Use technologies
only when they solve a real problem" (project brief) applies directly
here: introducing Redis now would be protecting against a deployment
topology this system has never had.

**Trade-off, explicitly accepted, not glossed over:**
- **State loss on API restart.** Every client's bucket resets to full
  the moment the API process restarts (verified real during the Phase
  12 chaos test -- after a deliberate process restart, the recovering
  API's rate limiter had no memory of any client's prior consumption).
  A client mid-throttle gets a clean slate.
- **No cross-instance coordination.** If this API is ever run as more
  than one process, each instance enforces its own independent
  100-requests/60s budget per client, not one shared budget -- a client
  could receive up to N times the intended allowance, where N is the
  instance count. If horizontal scaling is ever introduced, this
  limiter would need to move to a shared store (Redis or otherwise) at
  that time -- deferred, not forgotten.

## Decision: backpressure is DeadLetter-specific; rate limiting is not

**Context:** Both Phase 12 middleware protect POST /api/jobs. They
could have been combined into one middleware, or the backpressure
concept folded into the same generic rate-limiter abstraction.

**Chosen approach:** Two separate files with deliberately different
character. `rateLimiter.ts` has zero knowledge of jobs, outbox, or any
DeadLetter concept -- it is a generic admission-control primitive that
could be lifted into an unrelated Express project unchanged.
`backpressure.ts` directly imports `getStats()` and reads
`pendingOutboxEvents` -- it is meaningless outside this system.

**Why:** These are two genuinely different classes of protection. Rate
limiting protects against ANY client sending too many requests,
regardless of system health -- it would make sense even if the outbox
didn't exist. Backpressure protects against THIS system's actual
internal backlog, a signal that only exists because of Phase 10's
outbox design. Conflating them into one middleware would make the
generic half no longer generic, and would make the system-health half
harder to reason about in isolation (its own dedicated test file,
`backpressure.test.ts`, exercises real Postgres-seeded backlog state
without touching rate-limit token buckets at all, and vice versa for
`rateLimiter.test.ts`).

## Decision: backpressure applies to POST /api/jobs only, not POST /api/jobs/:id/replay

**Context:** Both routes write an outbox_events row (createJob and
claimReplay both call insertOutboxEvent inside their transaction, per
Phase 10). Backpressure could structurally have been applied to both.

**Chosen approach:** Backpressure checks pendingOutboxEvents and
rejects with 503 ONLY on POST /api/jobs. POST /api/jobs/:id/replay is
never rejected for backlog reasons, however high pendingOutboxEvents
is -- verified real via backpressure.test.ts's dedicated exemption test
and observed again during the Phase 12 chaos test (a real replay
request succeeded with 200 while pendingOutboxEvents sat at 51, over
threshold).

**Why:** Replay is how an operator drains an EXISTING backlog of
DEAD_LETTERED jobs back into the working system -- it doesn't add new,
unbounded work the way an unlimited stream of new job creation does; a
replay only ever re-queues a job that already exists and already
exhausted its retry budget once. Gating the one operation that recovers
from backlog behind that same backlog would be self-defeating: exactly
the moment an operator most needs to replay dead-lettered jobs (system
under strain, backlog high) is the moment backpressure would refuse
them.

**Trade-off:** A client could, in principle, drive pendingOutboxEvents
arbitrarily high via replay alone (each replay adds one outbox event).
Not mitigated in this phase -- replay traffic still shares the Phase 12
rate limiter's bucket with create-job traffic, which bounds the RATE of
replay-driven outbox growth even though backpressure itself does not.

## Decision: getStats() called fresh per request for backpressure, never cached

**Context:** Calling getStats() (one aggregate SQL query, including the
pendingOutboxEvents subquery) on every single POST /api/jobs request
adds real per-request latency and database load that a cached value
computed once every N seconds would avoid.

**Chosen approach:** No cache. `createBackpressureMiddleware()` calls
the existing, unmodified `getStats()` directly, on every request.

**Why:** A backpressure signal is only useful if it reflects the
system's CURRENT state. A cached value refreshed every, say, 5 seconds
would mean the API keeps admitting jobs for up to 5 more seconds after
the real backlog has already crossed the threshold -- precisely the
failure mode backpressure exists to prevent. The measured per-request
cost of the extra query (see observability.md) was judged acceptable
against that correctness gap; if this ever becomes a real bottleneck at
higher sustained throughput, a short-lived cache with an explicit
staleness bound would be the next thing to measure and consider -- not
introduced speculatively now.

## Decision: X-Test-Client-Id test-only header for rate-limiter client identity

**Context:** The rate limiter identifies clients by `req.ip` in normal
operation. Every request generated by the Jest test suite, and by k6
running from a single host, shares ONE source IP -- without some way to
assert a distinct identity per simulated client, "separate client
buckets" behavior (a required, real invariant to test) would be
impossible to exercise deterministically.

**Chosen approach:** `defaultIdentify()` reads an `X-Test-Client-Id`
header instead of `req.ip`, but ONLY when `NODE_ENV !== "production"`
(checked per-request, not at module load). In production, the header is
read never -- `defaultIdentify()` falls back to `req.ip` unconditionally,
verified real via a dedicated test that sends two requests with
different X-Test-Client-Id values but the same real req.ip under
NODE_ENV=production and confirms the second is rejected as the SAME
client.

**Why this is not a trust mechanism:** `req.ip` is derived from
Express's own resolution of the actual TCP connection's remote address
(trust proxy is false everywhere in this codebase, so `req.ip` is never
derived from X-Forwarded-For or any other client-supplied header). A
real external client cannot spoof it. `X-Test-Client-Id`, by contrast,
is trivially spoofable by design -- any caller can claim to be any
client. It is a development/test convenience gated entirely by
NODE_ENV, not a security boundary, and is documented as such directly
in rateLimiter.ts's own comments.

**Trade-off:** None in production (the header is inert there). In
non-production environments, anyone with network access to the API
could bypass their own rate limit by rotating the header value -- an
explicitly accepted, documented limitation of a dev/test convenience,
not a production concern.

## Decision: fixed Retry-After (5s) for backpressure, derived Retry-After for rate limiting

**Context:** The rate limiter computes Retry-After from the actual
token-bucket refill math (how many milliseconds until this specific
client has >=1 token again). Backpressure could theoretically do
something similar (e.g. estimate how long until pendingOutboxEvents
drops below threshold based on recent drain rate).

**Chosen approach:** Backpressure always returns `Retry-After: 5`,
a fixed value, regardless of how far over threshold pendingOutboxEvents
currently is.

**Why:** The rate limiter's refill rate is a known, deterministic
function of its own configuration (capacity/windowSeconds) -- computing
an exact Retry-After is just arithmetic. The outbox backlog's drain
rate depends on RabbitMQ's actual reachability and the dispatcher's
real throughput under real conditions, which cannot be predicted from
the pendingOutboxEvents count alone (a backlog under a live RabbitMQ
outage, per the Phase 12 chaos test, does not drain at a predictable
rate at all -- it does not drain until an operator intervenes, per
Incident 5). A precise-looking but fabricated estimate was judged worse
than an honest fixed value. 5 seconds is a reasonable client-retry
cadence, not a measured drain-time constant -- this is a locked design
default, not empirically derived.
## Decision: CI (Phase 13) runs build + Jest/Vitest only -- not k6, not chaos tests

**Context:** `.github/workflows/ci.yml` is the project's first CI
pipeline. `docs/load-testing.md` already documents k6 load scenarios
and manual RabbitMQ-outage chaos tests, both run by hand against real
Docker Compose infrastructure (see architecture.md's now-updated CI/CD
note).

**Chosen approach:** CI runs `tsc` builds and the Jest suites (`api`,
`worker`) and Vitest suite (`dashboard`) on every push/PR to `main`,
using GitHub Actions service containers for PostgreSQL/RabbitMQ. It
does **not** run any k6 scenario and does **not** run the manual
RabbitMQ-stop/start chaos test.

**Why:** k6 scenarios in this project run for a fixed wall-clock
duration (10-20s) at real load and their pass/fail signal is a
statistical shape (status-code distribution, latency percentiles), not
a simple assertion -- running them on every push would slow CI
substantially and their results are not the kind of thing a CI gate
should silently red/green on without a human reading the numbers. The
chaos test requires deliberately stopping the RabbitMQ service
mid-run, which GitHub Actions' service-container model does not
support cleanly (services are managed by the runner, not by the job's
own steps) and which would risk flaking unrelated jobs sharing the
same runner pool. This mirrors, rather than reverses, the project's
existing documented direction (`docs/load-testing.md`: "Not
containerized, not wired into any CI"). Load and chaos testing remain
real, manual, evidence-collecting exercises against real Docker
Compose infrastructure, run and reported the same way Phase 11 and
Phase 12 already did.

## Decision: CI database setup mirrors the documented manual `deadletter_test` setup exactly

**Context:** `deadletter_test` (used by both apps' `.env.test`) is
normally created by hand (`docs/testing.md`): `CREATE DATABASE
deadletter_test`, then piping each `infra/init-db/*.sql` file through
`psql` in order. There is no migration runner or ORM in this project.

**Chosen approach:** the CI workflow reproduces the exact same three
manual commands (`CREATE DATABASE`, then `001`, `002`, `003` in order)
against the `postgres` service container via `psql`, instead of
introducing a migration tool or baking a pre-migrated image.

**Why:** introducing a migration framework solely to make CI easier
would be new infrastructure not required by any current project
need (`.sql` files are hand-run everywhere else in this project, by
design -- see database.md), and it would make local dev and CI diverge
in how the schema gets built. Reusing the exact documented commands
keeps CI a faithful re-execution of the same real process a developer
already runs by hand, rather than a second, parallel source of truth
for schema setup.

## Decision: CI split into three independent jobs (api / worker / dashboard), not one combined job

**Context:** the monorepo has three real workspaces with different
runtime needs -- `api` and `worker` need PostgreSQL + RabbitMQ service
containers, `dashboard` needs neither.

**Chosen approach:** three separate GitHub Actions jobs, each with
its own checkout/install/build/test steps, running in parallel.

**Why:** a single combined job would pay for Postgres/RabbitMQ service
containers even while building/testing the dashboard, and a failure in
one workspace would obscure whether the other two workspaces were
still healthy. Three jobs give an independent pass/fail signal per
workspace in the Actions UI at the cost of some duplicated `npm ci`
time across jobs -- judged a reasonable, standard tradeoff for a
three-workspace monorepo of this size, not overengineering (no matrix
build, no reusable/composite actions, no custom Docker images were
introduced).

## Decision: Node.js 22 pinned in CI, matching the version this phase was actually built against

**Context:** no `engines` field or `.nvmrc` exists anywhere in this
repository to pin a Node version.

**Chosen approach:** `actions/setup-node@v4` with `node-version: "22"`.

**Why:** this is the Node major version (`v22.23.2`) actually used to
run `npx tsc` for `apps/api` and `apps/worker` and both `tsc -b` for
`apps/dashboard` during this phase's own verification (see
development-log.md, Phase 13) -- pinning to the version already proven
to build this repository, rather than guessing at `latest` or an
arbitrary LTS number. If the project's real development machine is on
a different Node major version, that should be reconciled explicitly
(an `.nvmrc` would be a reasonable follow-up), not silently assumed
here.

## Decision: RabbitMQ reconnection via event-listener cache invalidation, not a periodic liveness poll

**Context:** Phase 14 needed to fix Incident 5/8 (connection.ts caches
a channel and never notices when it dies).

**Chosen approach:** attach `'error'`/`'close'` listeners to the
connection and channel at creation time, and null the cache reactively
when either fires, rather than periodically calling something like
`checkQueue()` on a timer to proactively probe liveness.

**Why:** amqplib already emits these events the moment the underlying
socket/protocol actually closes -- reacting to them is immediate and
free. A polling probe would either run so infrequently that recovery
is still slow, or so frequently that it adds meaningful, pointless
RabbitMQ traffic under normal healthy operation, for information the
library is already handing over via events. This is also literally
the fix Phase 6 identified by name ("event-listener-driven cache
invalidation") -- implementing anything else would be solving a
different, unasked-for problem.

## Decision: identity-checked invalidation, not a blind module-level null

**Context:** the straightforward version of the fix is: `connection.on
("close", () => { channel = null; connection = null; })`. That has a
real race: amqplib's "close"/"error" delivery is asynchronous relative
to application code, so a **stale** event from an already-replaced
connection could fire after `getChannel()` has already reconnected,
and blindly null the module state would clobber the new, healthy
connection based on an event about the old, already-dead one.

**Chosen approach:** each listener closes over the exact
connection/channel instance it was attached to and only nulls the
module-level cache if that instance is still the one currently cached
(`if (connection !== newConnection && channel !== newChannel) return;`).

**Why:** this is the minimum change needed to make the fix actually
correct rather than introducing a new, subtler bug while fixing an old
one -- silently breaking a healthy connection because of a
late-arriving event about a connection that was already, correctly,
replaced would be a regression, not a fix.

## Decision: worker reconnect backoff is separate from job-level retry policy

**Context:** `apps/worker/src/retry/retryPolicy.ts` already has
`calculateBackoffMs()` for job processing retries (Phase 4).

**Chosen approach:** `consumer.ts`'s `resubscribeWithBackoff()` uses
its own small, local, capped-exponential constants (1s base, doubling,
30s ceiling) rather than reusing `calculateBackoffMs()`.

**Why:** `calculateBackoffMs()` is parameterized by a job's
`attempt_count` and is tuned for how long a job-type-specific
downstream dependency might need before a retry is worth attempting --
a business/job-processing concern with its own tuning history (see the
Phase 4 decision on the backoff formula/constants). Connection-level
reconnection is a different concern (how fast should this process try
to re-establish transport to its own message broker) with different
natural time constants, and reusing the job-retry function would
couple two unrelated pieces of tuning together for no real benefit --
changing one's constants for job-processing reasons would silently
change the other's reconnect cadence too.

## Decision: an intentional-close guard (`closingIntentionally`), not skipping listener attachment during shutdown

**Context:** `closeConnection()` (called by both apps' clean-shutdown
paths) calls `channel.close()`/`connection.close()`, which themselves
trigger the exact same `'close'` events the new invalidation logic
listens for. Without a guard, a normal SIGTERM/SIGINT shutdown would
emit `"invalidated"`, and on the worker side that would kick off
`resubscribeWithBackoff()` -- attempting to reconnect to RabbitMQ
moments before the process exits.

**Chosen approach:** a module-level `closingIntentionally` flag, set
`true` for the duration of `closeConnection()` and checked inside the
invalidation handler before it emits `"invalidated"`.

**Why:** the alternative -- removing the listeners before calling
`.close()` -- is more fragile (has to precisely track and remove the
exact listener functions that were attached, per connection instance)
for the same result. A single boolean checked in one place is simpler
and keeps `getChannel()`'s listener-attachment logic itself unchanged
regardless of why a close might later happen.

## Decision: unit-test the reconnection logic against a mocked amqplib, not skip testing it

**Context:** the whole point of Phase 14 is behavior that can only be
observed by actually breaking a live RabbitMQ connection -- something
no earlier phase's tests attempt, because every existing test that
touches RabbitMQ does so against a real, healthy broker (see
`dispatcher.test.ts`'s own "real RabbitMQ" framing). This session's
environment has no way to start or stop a real broker (see
development-log.md, Phase 14).

**Chosen approach:** three new unit tests
(`apps/api/src/__tests__/unit/connectionRecovery.test.ts`,
`apps/worker/src/__tests__/unit/connectionRecovery.test.ts`,
`apps/worker/src/__tests__/unit/consumerResubscribe.test.ts`) that
`jest.mock("amqplib")` with a small fake `EventEmitter`-based
connection/channel, so a broker "dying" can be simulated deterministically
by emitting a `'close'`/`'error'` event on the fake objects.

**Why:** this is the first place in the project that mocks amqplib
rather than using a real broker -- a deliberate, narrow exception to
the project's general "test against real infrastructure" preference
(see testing.md), made only because the specific behavior under test
(does the cache-invalidation/resubscribe LOGIC run correctly when a
disconnect event fires) is not otherwise triggerable at all inside a
Jest run, real broker or not. This does not replace real chaos-test
evidence -- it proves the logic is internally correct; only a real
RabbitMQ outage against the real Docker Compose stack proves the whole
system recovers. That outage has since been performed for real, with
neither the API nor the worker process restarted (see
incidents-and-failures.md, Incident 8's Phase 14 update, and
development-log.md's Phase 14 addendum for the full result).

## Decision: preserve the worker's existing initial-boot-failure behavior unchanged

**Context:** if RabbitMQ is unreachable when the worker first starts,
`startConsumer()` (via `getChannel()`) throws, and `index.ts`'s
`.catch(err => { logger.error(...); process.exit(1); })` exits the
process -- existing, Phase 0-era behavior, unrelated to Incident 5/8
(which is specifically about a connection that was previously working
and then died, not initial connectivity).

**Chosen approach:** Phase 14 does not touch this path.
`resubscribeWithBackoff()`'s retry loop is wired only to the
`"invalidated"` event, which fires after a successful connection is
later torn down -- never on the very first connect attempt made by
`startConsumer()` itself.

**Why:** retrying indefinitely on initial boot is a different,
reasonable-but-separate design question (should the worker wait for
RabbitMQ to become available, or fail fast so an orchestrator/operator
notices immediately) that the project has not asked to have answered
here, and changing it would be exactly the kind of "redesign a working
system because you see a possible improvement" this project's
guardrails explicitly warn against.

## Decision: replace pool.on("error") => process.exit(1) with log-only handling

**Context:** `apps/api/src/db/pool.ts` and `apps/worker/src/db/pool.ts`
both called `process.exit(1)` on any pool-level `"error"` event --
discovered during Phase 15's scoping review, not previously documented
anywhere in this project. `pg.Pool` emits `"error"` for an
already-connected, currently-IDLE client hitting a background/network
failure; it does not mean the pool as a whole is unusable, and `pg.Pool`
already discards that one client and creates a fresh one lazily on the
next query. Neither app is process-supervised in this project's real
deployment (`infra/docker-compose.yml` only runs `postgres`/
`rabbitmq`; API/worker run via `npm run dev`), so this crash had no
automatic recovery path at all.

**Options considered:** (1) leave `process.exit(1)` -- fail fast and
loud, relying on an external supervisor to restart the process; (2) log
only, let `pg.Pool` self-heal.

**Chosen approach:** (2). `pg.Pool`'s own internal behavior already
makes a hard crash unnecessary for this specific event -- the pool
does not need external intervention to keep working after one idle
client errors.

**Why:** option (1) directly contradicts Phase 14's own conclusion for
the exact same class of problem (a dependency connection dying) on the
RabbitMQ side: react to the failure signal and let the existing
mechanism self-heal, rather than requiring a full process restart.
There is also no supervisor in this project to make "fail fast and let
something else restart it" a real recovery path -- in practice it was
just "fail," permanently, until a human noticed.

**Trade-offs:** this does reverse a Phase-0-era choice, even though
that choice was never explicitly written down as a deliberate decision
(no prior doc referenced it). Recording that trade-off here rather
than silently flipping it. Every *foreground* query-error path (the
outbox dispatcher's try/catch, the worker's DB-error catch blocks, the
readiness route's `Promise.allSettled`) is untouched by this change --
this only affects the pool's own *background* error event.

## Decision: worker DB-error backoff is a local, in-process, capped counter -- not a DB-recorded retry

**Context:** `apps/worker/src/consumer.ts`'s two DB-error catch blocks
NACK-and-requeue immediately, with no delay -- flagged as a known
limitation since Phase 4 ("could hot-loop under a sustained outage").

**Options considered:** (1) route DB-error failures through the
existing retry queue (TTL + DLX, the same mechanism `retryPolicy.ts`
uses for business-logic failures); (2) a small, local, in-process
capped-exponential backoff, sleeping before NACK, with a
consecutive-error counter that lives only in memory.

**Chosen approach:** (2).

**Why:** option (1) is not actually available here -- recording a
retry (via `markRetrying()`/`publishRetry()`) requires a successful DB
write, which is precisely what just failed. The existing
`isInvalidTextRepresentationError`/genuine-infrastructure-failure split
already established that this class of error means "nothing was
recorded, nothing CAN be recorded right now." A local, in-memory
backoff sidesteps that entirely: no DB write attempted, no dependency
on the thing that is down. The 1s-base/doubling/30s-cap shape
deliberately mirrors Phase 14's `resubscribeWithBackoff`, but is kept
as a fully separate mechanism and counter -- same separation principle
Phase 14 used for connection-liveness backoff vs. job-processing retry
backoff (`retryPolicy.ts`'s `calculateBackoffMs`), which remains
completely untouched.

**Trade-offs:** because the counter is per-worker-process and purely
in-memory, it resets on any process restart and is not shared across
multiple worker processes -- each worker independently throttles its
own redelivery rate. With N worker processes, the aggregate
redelivery rate during a sustained outage is bounded by N / (current
backoff interval) rather than by a single shared budget. Considered
sufficient for this project's scale; a shared/coordinated backoff
would be meaningful overengineering for a problem this narrow.

## Decision: mock the "pg" module for the pool-error and DB-error-backoff unit tests

**Context:** a `pg.Pool`'s `"error"` event, and a sustained sequence of
DB-query failures, cannot be deterministically triggered against a
real, healthy `deadletter_test` database inside a Jest run.

**Chosen approach:** `apps/api/src/__tests__/unit/poolErrorHandling.test.ts`,
`apps/worker/src/__tests__/unit/poolErrorHandling.test.ts`, and
`apps/worker/src/__tests__/unit/dbErrorBackoff.test.ts` `jest.mock("pg")`
(for the pool tests) and `jest.mock("../../services/jobService")` /
`jest.mock("../../processors/jobProcessor")` /
`jest.mock("../../queue/retryPublisher")` (for the backoff test), the
same narrow, deliberate exception to "test against real infrastructure"
that Phase 14 established for `amqplib` -- for the identical reason:
the specific failure signal under test is not otherwise triggerable at
all inside a Jest run, real database or not. This does not replace a
real chaos test against a genuine sustained Postgres outage, which
remains the authoritative evidence (see incidents-and-failures.md,
Phase 15 entry).

## Decision: preserve the worker's initial-boot RabbitMQ-connect-failure exit, and every existing foreground DB-error handler, unchanged

**Context:** Phase 15's fixes are specifically about the PostgreSQL
pool's *background* error event and the worker's *DB-error* NACK
paths. Two nearby, superficially-similar behaviors must NOT be
confused with either of these.

**Chosen approach:** `apps/worker/src/index.ts`'s
`startConsumer().catch(err => { logger.error(...); process.exit(1); })`
is untouched -- it is a one-time startup check on the RabbitMQ
dependency, a different dependency and a different, deliberate Phase
14 decision (see "preserve the worker's existing initial-boot-failure
behavior unchanged" above), not the runtime PostgreSQL pool event this
phase addresses. Likewise, every existing *foreground* query-error
handler that was already correctly catching and handling a failed
`pool.query()` call at its own call site (the outbox dispatcher's
try/catch, `routes/health.ts`'s `Promise.allSettled`, the worker's own
try/catch blocks around `claimJob`/`markCompleted`/`markRetrying`/
`markDeadLettered`) is untouched -- Phase 15 only adds a backoff sleep
immediately before the two NACK calls those handlers already had;
their control flow and error classification are otherwise identical.

**Why:** conflating "the pool had a background error" with "a
foreground query just failed," or "PostgreSQL is unreachable" with
"RabbitMQ is unreachable at boot," would blur two independently
correct, already-decided behaviors for no benefit -- exactly the kind
of unrelated-component modification this project's guardrails warn
against.

## Decision: split success from bookkeeping in the worker's message-completion path (Phase 16)

**Context:** the final engineering audit that preceded Phase 16 found
a real correctness gap in `apps/worker/src/consumer.ts`: the original
code wrapped both `await processJob(job)` and the follow-up
`await markCompleted(jobId)` in a single `try` block. If `processJob`
succeeded but `markCompleted` then threw (e.g. a transient Postgres
connection drop right after the job's real side effects already ran),
the single `catch` had no way to tell the two apart -- it classified
this exactly like a genuine business-logic failure, and could retry or
even dead-letter a job whose work had already been done.

**Chosen approach:** track success and failure as two explicit,
separate steps. `processJob()` runs in its own try/catch that only
sets a `processingSucceeded` flag and captures any error. If it
succeeded, `markCompleted()` runs in a *second*, independent
try/catch: success acks normally; failure there requeues via the
existing backoff-then-nack helper (already built for Phase 15's
DB-error backoff) and is logged explicitly as "processJob() succeeded
but markCompleted() failed to record it," never routed through the
retry-count/dead-letter classification meant for real processing
failures. Only when `processingSucceeded` is false does the original
classification logic (retryable vs. exhausted vs. non-retryable) run
at all.

**Why not just add a broader catch or a flag inside the existing
single try block:** that would still couple two independently-failing
operations' error handling together, and would be easy to silently
regress the next time either code path changes. Separating them into
two try/catches with an explicit boolean makes the two failure modes
structurally impossible to conflate, not just correctly handled today
by convention.

**Verification:** a new test file,
`apps/worker/src/__tests__/unit/markCompletedFailure.test.ts`, proves
the specific case this fix targets (`processJob` succeeds,
`markCompleted` throws -> requeue via backoff, and
`markRetrying`/`markDeadLettered`/the retry and dead-letter publishers
are asserted to never have been called) alongside two regression
guards (the normal success path, and a genuine processing failure
still being classified and retried as before). Real run from this
session: 3/3 passed. This does not change `claimJob`'s atomic-claim
semantics or the idempotency guarantees that already existed --
requeueing after a `markCompleted` failure is safe precisely because a
later redelivery re-enters the same atomic claim path (proven
separately by the new `idempotency.test.ts`).

## Decision: single VPS + Docker Compose + Caddy for public deployment, not a managed database, serverless platform, or Kubernetes (Phase 16)

**Context:** the master finalization brief asked for an actual public,
production-oriented deployment, while explicitly ruling out
Kubernetes, Kafka, Redis, a service mesh, or any infrastructure added
for its own sake, and explicitly preferring no cold starts and
everything colocated in one region.

**Options considered:**
- *Managed Postgres + managed RabbitMQ/queue + serverless API/worker
  compute.* Rejected: adds real monthly cost and provider-specific
  operational surface (IAM, network peering, cold starts on
  serverless compute) to solve a problem this project doesn't have.
  Running Postgres and RabbitMQ ourselves, safely, through real
  failures, was the explicit point of Phases 1-15 -- swapping that out
  for a managed service at the finish line would undercut the
  project's own stated learning goals, not just add unneeded
  infrastructure.
- *Kubernetes.* Rejected outright per the brief's explicit rule; would
  also be solving a scaling/orchestration problem this single-region,
  single-operator system does not have.
- *Single VPS + Docker Compose, all services colocated, Caddy as a
  TLS-terminating reverse proxy in front of only the dashboard's
  published port.* **Chosen.** Matches every stated constraint: no
  cold starts, one region, minimal new infrastructure (a reverse proxy
  most of this project's Docker/Compose work already prepared it for),
  and it is the natural continuation of the `docker-compose.prod.yml`
  topology already built in this same phase (Postgres/RabbitMQ with no
  published ports, dashboard nginx as the sole public entry point).

**Why Caddy specifically, over nginx+certbot or a manual TLS setup:**
Caddy issues and renews Let's Encrypt certificates automatically with
a Caddyfile of a few lines, removing an entire class of
certificate-expiry incident for a single-operator project with no
dedicated ops rotation to watch for it. This is not a new architectural
component competing with the existing nginx (which stays exactly where
it is, serving the dashboard's static build and reverse-proxying
`/api`/`/ws` internally) -- Caddy only replaces where TLS termination
and the public port would otherwise have to be handled manually.

**Not yet executed:** this decision produced the target architecture
and the Docker/Compose work to support it (`docs/deployment.md`), but
an actual VPS account and a real domain are required to provision and
point at, and both can only come from the project owner. This decision
record exists so the *reasoning* is captured even though the
deployment itself is still pending that external input.
