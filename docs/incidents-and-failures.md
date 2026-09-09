# Incidents & Failures

## Incident 1 — TypeScript compile failure: verbatimModuleSyntax vs CommonJS

**Date:** 2026-09-08

**Expected behavior:** `npm run dev` compiles `src/config/env.ts` and
`src/index.ts` and runs them.

**Actual behavior:** TypeScript compilation failed with TS1295 and TS1287,
refusing to compile `import`/`export` syntax.

**How it was reproduced:** Ran `npm run dev` immediately after creating
`src/config/env.ts` with standard ES `import`/`export` syntax.

**Root cause:** `tsc --init`'s generated `tsconfig.json` set
`"module": "nodenext"` and `"verbatimModuleSyntax": true`. `nodenext`
makes TypeScript infer each file's module format from `package.json`'s
`"type"` field, which was `"commonjs"` (npm's default, never changed).
`verbatimModuleSyntax` requires import/export syntax to be emitted
unchanged, which is impossible for a file being compiled as CommonJS,
since CommonJS uses `require()`/`module.exports`, not `import`/`export`.
The two settings were contradictory for our actual project type.

**Fix:** Changed `tsconfig.json`: `"module"` set to `"commonjs"`,
`"verbatimModuleSyntax"` set to `false`, and added
`"esModuleInterop": true` to allow default-style imports from CommonJS
packages (e.g. `import express from "express"`).

**Verification:** `npm run dev` compiled and ran successfully afterward,
printing expected environment values.

**Engineering lesson:** `tsc --init`'s defaults assume an ESM project by
default in recent TypeScript versions. A CommonJS project (the npm
default, and what we're using) needs `module` and `verbatimModuleSyntax`
explicitly aligned with that choice — the generated config is not
plug-and-play for every project type, and the error messages, while
initially alarming, directly named the fix.


## Incident 2 — noUncheckedIndexedAccess flags createJob's return as possibly undefined

**Date:** 2026-09-08

**Expected behavior:** `createJob` compiles cleanly, returning `Job`.

**Actual behavior:** TypeScript error TS2322 — `result.rows[0]` typed as
`Job | undefined`, not assignable to the declared `Promise<Job>` return
type.

**How it was reproduced:** Ran `npm run dev` after writing
`jobService.ts` with `return result.rows[0];` in `createJob`.

**Root cause:** `tsconfig.json` has `"noUncheckedIndexedAccess": true`,
which makes TypeScript treat all array index access as potentially
`undefined`, since the type system cannot prove an INSERT...RETURNING
query always returns a row.

**Fix:** Added an explicit runtime check — if `result.rows[0]` is
falsy, throw an explicit error instead of silently returning
`undefined`. This satisfies the type checker and adds a real safety net
if the assumption (INSERT always returns exactly one row) is ever
violated by a future change.

**Verification:** `npm run dev` compiled and ran successfully;
`createJob` returned a real inserted row from Postgres.

**Engineering lesson:** `noUncheckedIndexedAccess` is doing its job
correctly here — it's not a nuisance to silence, it's forcing an
explicit decision about what happens in a case the code was implicitly
assuming away.


## Incident 3 — verbatimModuleSyntax error in worker, but code ran anyway

**Date:** 2026-09-09

**Expected behavior:** `npx tsc` in `apps/worker` compiles cleanly,
matching the fix already applied to `apps/api` in Incident 1.

**Actual behavior:** 15 TypeScript errors (TS1295, TS1287, TS1484),
identical in nature to Incident 1 — but `node dist/queue/test-manual.js`
ran successfully immediately afterward, despite the reported errors.

**How it was reproduced:** Ran `npx tsc` in `apps/worker` after creating
`env.ts`, `connection.ts`, and `test-manual.ts` with standard
import/export syntax.

**Root cause:** Two separate issues:
1. The worker's `tsconfig.json` was scaffolded in Phase 0, before
   Incident 1 (in Phase 1) revealed the `module`/`verbatimModuleSyntax`
   contradiction for CommonJS projects. The fix was applied to the API's
   config at the time but never retroactively applied to the worker's,
   since the worker had no TypeScript files using import/export yet at
   that point.
2. Neither app's `tsconfig.json` had `noEmitOnError` set, so TypeScript's
   default behavior (emit JavaScript output even when errors are
   reported) meant the broken compile still produced a runnable
   `dist/queue/test-manual.js`, masking the fact that the build was
   actually broken.

**Fix:**
- Applied the same fix as Incident 1 to `apps/worker/tsconfig.json`:
  `module: "commonjs"`, `verbatimModuleSyntax: false`,
  `esModuleInterop: true`
- Added `noEmitOnError: true` to **both** `apps/api/tsconfig.json` and
  `apps/worker/tsconfig.json`, so a broken compile can no longer
  silently produce output in either app

**Verification:** `npx tsc` in both `apps/api` and `apps/worker` now
completes with zero errors and zero output.

**Engineering lesson:** A script exiting successfully or running
without a runtime crash is not proof the build was actually correct —
`tsc` reporting compile errors while still emitting usable output is a
real gap that could hide broken code. `noEmitOnError`


## Deliberate Test 1 — Worker crash before ACK triggers redelivery

**Date:** 2026-09-09

**Purpose:** Verify RabbitMQ's redelivery guarantee actually works, per
the project's requirement to test failure behavior rather than assume
it, before building retry/DLQ logic on top of an unverified assumption.

**Setup:** Temporarily added a 15-second artificial delay to the
worker's message handler (before the ACK call), to create an observable
window where a message is received but not yet acknowledged.

**Procedure:**
1. Started one worker, confirmed via RabbitMQ UI: 1 consumer connected
2. Published one job via real `POST /api/jobs` request
   (jobId: `19903a41-45a5-4c60-89d1-7740c31e0130`)
3. Worker received the message, logged it, entered the 15-second sleep
4. Killed the worker process (Ctrl+C) mid-sleep, before the ACK line
   executed — simulating an unexpected crash during processing

**Observed behavior:**
- RabbitMQ management UI immediately showed the message transition
  from Unacked back to Ready (confirmed visually via the queue's
  message-state graph)
- No message was lost — Total count remained 1 throughout
- Started a fresh worker process; it immediately received the exact
  same message (same jobId) without any manual intervention —
  RabbitMQ redelivered it automatically upon detecting the original
  consumer's connection had dropped
- The second attempt ran to completion and acknowledged normally

**Conclusion:** RabbitMQ's core reliability mechanism — detecting a
dropped consumer connection and redelivering unacknowledged messages —
works as documented, verified by direct observation rather than
assumed from RabbitMQ's documentation.

**Engineering implication (tracked forward):** This same mechanism is
also the direct cause of the duplicate-processing problem Phase 5 must
address. If real processing had already produced a side effect (e.g.,
sent an actual email) before the simulated crash, that side effect
would not be undone — redelivery guarantees at-least-once delivery,
not exactly-once execution. This test makes that risk concrete rather
than theoretical, ahead of building idempotency protection.

**Cleanup:** Artificial delay removed from `consumer.ts` after the
test; confirmed clean recompile with no errors.


## Deliberate Test 2 — Reproducing the DB/RabbitMQ consistency problem

**Date:** 2026-09-09

**Purpose:** Directly reproduce and observe the DB-write-succeeds-but-
publish-fails scenario tracked since Phase 0's architecture.md, rather
than solving it speculatively without evidence.

**Setup:** Stopped the RabbitMQ container (`docker compose stop
rabbitmq`) while leaving PostgreSQL running, simulating a broker outage
while the database remains available.

**Procedure:**
1. Confirmed via `docker compose ps`: PostgreSQL healthy, RabbitMQ
   stopped
2. Started the API fresh — confirmed it boots successfully even with
   RabbitMQ down (connection is lazy; only attempted on first publish,
   not at startup)
3. Sent `POST /api/jobs` with `type: "consistency_test"`

**Observed behavior:**
- Request returned HTTP `500` after ~462ms, with a raw, unhandled
  `AggregateError [ECONNREFUSED]` stack trace leaked directly to the
  client as an HTML error page — not a clean JSON error response
- pino-http's error log captured its own internal wrapper message
  ("failed with status code 500") rather than the actual underlying
  `ECONNREFUSED` cause — the real error was only visible via the raw
  stack trace printed separately to the console, not through our
  structured logging
- Direct query against PostgreSQL confirmed: a real job row was
  persisted — `id: 4581724a-1155-4dcf-a98b-da7e0a640582`,
  `type: consistency_test`, `status: QUEUED`, with a real timestamp
- This job will remain `QUEUED` forever. No message was ever published
  to RabbitMQ, so no worker will ever learn this job exists. There is
  currently no mechanism in the system to detect or recover this job.

**Conclusion:** The tracked consistency problem is real and reproducible
on demand, not a theoretical edge case. The current implementation has
no defense against it — `jobService.createJob` performs the INSERT and
the publish as two independent, non-atomic steps, in sequence, with no
compensating action if the second step fails after the first succeeds.

**Secondary findings from this test** (worth fixing regardless of the
consistency decision):
1. Unhandled errors in route handlers currently leak raw stack traces
   to clients via Express's default error handler — no centralized
   error-handling middleware exists yet.
2. Structured logging does not currently capture the true root cause of
   an error clearly — pino-http logs its own wrapper, not necessarily
   the original exception in an easily greppable form.

**Not fixed yet — deliberately.** Per the original project plan, we are
not implementing a fix (e.g., the transactional outbox pattern) until
this evidence exists and can inform the decision. See
`engineering-decisions.md` for the options now under real consideration.

**Test data:** The stuck job (`4581724a-1155-4dcf-a98b-da7e0a640582`)
was left in the database as evidence rather than deleted.


## Incident 4 — Malformed jobId caused infinite redelivery loop

**Date:** 2026-09-09

**Expected behavior:** A message with an invalid jobId should be safely
discarded, similar to how malformed JSON is already handled.

**Actual behavior:** During manual Phase 5 concurrency testing, a
message was accidentally published via the RabbitMQ UI with the literal
placeholder text `{"jobId":"<paste the jobId here>"}` instead of a real
UUID. claimJob()'s parameterized query passed this string directly to
Postgres as a UUID column parameter, which Postgres rejected with error
code 22P02 (invalid_text_representation). The consumer's catch block
treated ALL thrown errors during claim as transient infrastructure
failures and unconditionally NACKed with requeue=true. Since the error
is deterministic (the string will never become a valid UUID), this
caused an infinite redelivery loop -- confirmed via RabbitMQ UI showing
sustained ~31 deliveries/sec with a matching ~31/sec Redelivered rate,
Unacked=1 held continuously.

**How it was reproduced:** Deliberately re-triggered by publishing
`{"jobId":"not-a-real-uuid"}` via the RabbitMQ UI after the fix was
implemented, to confirm both the original failure mode and the fix.

**Root cause:** No distinction was made between a permanently malformed
message (unrecoverable, should never be retried) and a genuine
transient infrastructure error (recoverable, should be requeued) when
an error occurred during the claim attempt.

**Fix:** Added `isInvalidTextRepresentationError()`, checking for
Postgres error code 22P02 specifically. When detected, the message is
ACKed and discarded (same treatment as malformed JSON) instead of
requeued. All other errors during claim continue to be treated as
infrastructure failures and requeued, unchanged.

**Verification:** Reproduced the exact failure with a deliberately
invalid jobId after the fix; confirmed exactly one log line
("Malformed jobId (invalid UUID)...") with no loop, and RabbitMQ UI
showing a single delivery spike with zero redelivery activity,
Ready/Unacked/Total all settling at 0.

**Engineering lesson:** Not all errors caught in a broad try/catch are
equivalent. Treating "the operation failed" as a single category
(rather than distinguishing permanent/data-level failures from
transient/infrastructure failures) can turn a trivial bad-input mistake
into a sustained resource-consuming loop. This was found through manual
testing, not code review -- a concrete argument for why the project's
emphasis on real execution over assumed correctness matters.