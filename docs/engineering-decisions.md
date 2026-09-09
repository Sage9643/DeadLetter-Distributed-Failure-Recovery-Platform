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