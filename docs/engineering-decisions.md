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