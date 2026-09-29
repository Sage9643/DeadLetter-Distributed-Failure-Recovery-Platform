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


## Deliberate Test 3 — DB/RabbitMQ dual-write gap reproduced on the replay path

**Date:** 2026-09-10

**Purpose:** Verify whether the DB/RabbitMQ consistency limitation
tracked since Phase 0/2 (Deliberate Test 2) also applies to the new
Phase 6 replay write path, rather than assuming it does.

**Procedure:**
1. Created and dead-lettered a job (id 7c305a47-5624-4300-bce4-9db927538834)
2. Stopped RabbitMQ (`docker compose stop rabbitmq`), confirmed
   PostgreSQL remained healthy
3. Called POST /api/jobs/:id/replay against the dead-lettered job

**Observed behavior:**
- Request returned HTTP 500 with a raw, unhandled stack trace:
  `IllegalOperationError: Channel closed` at publishJobCreated
- Database query immediately after confirmed: status=QUEUED,
  replay_count=1 -- the atomic claimReplay UPDATE had already
  committed successfully (it has no RabbitMQ dependency) BEFORE the
  publish attempt failed
- Restarted RabbitMQ, confirmed healthy via `docker compose ps`
- Re-queried the job: still status=QUEUED, unchanged, even with
  RabbitMQ fully healthy again -- no automatic recovery occurred

**Conclusion:** The dual-write gap first identified in Phase 0/2 is
confirmed to apply identically to the replay path. A job can be
genuinely, permanently stuck in QUEUED with no message ever published
and no automatic detection or recovery mechanism.

**Not fixed.** Consistent with the project's standing decision not to
implement an outbox pattern without further justification. This test
adds a second, independent confirmation of the same known limitation
class, not a new problem.

## Incident 5 — API RabbitMQ channel does not recover after broker restart

**Date:** 2026-09-10

**Trigger:** RabbitMQ was deliberately stopped during Deliberate Test 3
(above).

**Expected behavior:** After RabbitMQ was restarted and confirmed
healthy, subsequent API operations requiring a publish should succeed
normally.

**Actual behavior:** A subsequent, UNRELATED `POST /api/jobs` request
(creating a fresh job, `phase6_regression_stale`, for an entirely
separate regression test) ALSO failed with the identical error:
`IllegalOperationError: Channel closed` at publishJobCreated -- even
though RabbitMQ had already been restarted and `docker compose ps`
confirmed it healthy. This confirmed the failure was not specific to
the replay path, but affected all API publishing.

**Root cause (confirmed via code inspection, not speculated):**
`apps/api/src/queue/connection.ts`'s `getChannel()` caches the channel
in a module-level variable and checks only whether that variable is
non-null before deciding whether to reconnect -- it never checks
whether the cached channel/connection are still actually alive. No
event listeners (`connection.on('close', ...)`,
`channel.on('close', ...)`, etc.) are registered anywhere in the file,
so nothing ever detects the broker disconnection and resets the cached
references to null. The stale, dead Channel object remained cached
indefinitely; amqplib's own internal closed-state check is what threw
`IllegalOperationError` synchronously on every subsequent `.publish()`
call against it.

**Recovery:** Restarting the API process (`npm run dev`) re-initialized
the module, resetting `channel`/`connection` to null, which forced a
genuine fresh `amqp.connect()` on the next request. Confirmed real:
the next POST /api/jobs succeeded normally (201) immediately after
restart.

**Impact:** API publish operations (both job creation and replay) can
remain completely unavailable after ANY broker restart or connection
drop, for an indefinite period, until someone notices and manually
restarts the API process. No automatic detection, alerting, or recovery
exists.

**Current mitigation:** None automated. Manual API process restart is
the only recovery path currently available.

**Not fixed in Phase 6.** Per explicit instruction, no implementation
change was made. Automatic RabbitMQ connection/channel recovery
(reconnection logic with event-listener-driven cache invalidation, and
likely a retry/backoff strategy for reconnection attempts) is
identified as a concrete future improvement, out of scope for this
phase.

**Update (Phase 14):** implemented -- see the Phase 14 update at the
end of Incident 8 below for the fix and its current validation status.

**Engineering lesson:** A cached resource (connection, channel, client)
needs an explicit invalidation path tied to the actual liveness of the
underlying resource, not just a "does this variable exist" check.
Discovering this required deliberately breaking the same dependency
(RabbitMQ) that Phase 0/2's original dual-write test already targeted --
a second, unplanned finding surfaced by intentionally causing a real
failure, not by code review.


## Deliberate Test 4 -- RabbitMQ outage reproduced and recovered via the outbox

**Date:** 2026-09-16

**Purpose:** Verify the Phase 10 outbox actually closes the dual-write
gap Phase 2 (Deliberate Test 2) and Phase 6 (Deliberate Test 3) both
proved was broken, rather than assuming the new code works.

**Procedure:** Stopped RabbitMQ (`docker compose stop rabbitmq`).
Created a job via real POST /api/jobs (jobId
b9bb76d4-2ed6-4914-bcf4-4de556167ae4).

**Observed:**
- Request returned a clean 201 {"status":"QUEUED"} -- NOT the 500
  IllegalOperationError that the identical scenario produced in Phase
  2/6, confirming job creation genuinely no longer depends on RabbitMQ
  being reachable.
- DB confirmed: status=QUEUED, a real pending outbox_events row
  (published_at NULL).
- The dispatcher's real structured logs showed repeated
  "Outbox dispatch failed; will retry" entries with a real
  AggregateError (ECONNREFUSED on both ::1:5672 and 127.0.0.1:5672),
  roughly every 2 seconds -- confirming active, sustained retry, not a
  stall. attempts climbed from 13 to 45 to 153 across the observation
  window.
- Restarted RabbitMQ, confirmed healthy via docker compose ps.
- Within 2 seconds of the API's next dispatcher tick after RabbitMQ
  became healthy, the outbox row's published_at was populated
  (2026-09-16 13:08:19.64682+00) -- fully automatic recovery, zero
  manual resubmission of the job. attempts correctly remained at 153,
  preserving the full historical retry count rather than resetting it.
- (No worker process was running during this test, so the job itself
  remained status=QUEUED/attempt_count=0 in the jobs table --
  deliberately isolating what was being tested: publication durability,
  not worker consumption, which was already proven separately in
  Phases 3-5.)

**Conclusion:** The exact class of incident reproduced in Phase 2 and
Phase 6 is now demonstrably closed -- a real job survived a real
RabbitMQ outage with zero data loss and zero manual intervention.

## Incident 6 -- Leftover duplicate-publish call in the replay route (caught before commit)

**Date:** 2026-09-16

**Expected behavior:** After Phase 10, a successful replay should
trigger exactly one eventual RabbitMQ publish, via the outbox
dispatcher only.

**Actual behavior found:** apps/api/src/routes/jobs.ts's replay handler
still contained the ORIGINAL Phase 6 line, `await
publishJobCreated(job.id);`, called directly after claimReplay
succeeded -- even though the Phase 10 version of claimReplay already
atomically inserts a pending outbox_events row in the same transaction.
Every successful replay would have triggered the message publish
TWICE: once synchronously via this leftover call, once asynchronously
via the dispatcher.

**How it was found:** NOT caught by the full 51-test API suite passing
-- those tests mock publishJobCreated (jest.mock) and assert only HTTP
response shape/status codes, never call count. Caught specifically by
the mandated regression-diff step: `git diff 902d194... --
apps/api/src/routes/jobs.ts` unexpectedly returned ZERO output,
revealing that an earlier full-file replacement instruction had never
actually been applied to disk (a file-editing miss, not a design
flaw).

**Root cause:** A file replacement given during implementation was
never applied; the file silently retained its pre-Phase-10 content
until the regression-diff check surfaced the discrepancy.

**Fix:** Removed the leftover publishJobCreated call and its
now-inaccurate comment; removed the now-unused import. Verified via a
direct `type` of the corrected file (confirming no publishJobCreated
reference remains anywhere in it), then reran the full test suite:
13 suites / 51 tests still passing after the fix.

**Status:** Caught and fixed during implementation, BEFORE any commit
-- never shipped. Recorded here per this project's standing discipline
of documenting real incidents, not only production ones.

**Engineering lesson:** A passing test suite is not sufficient proof
that a specific behavioral change (here: removing a call site) was
actually applied -- the mandated diff-against-a-known-commit check
caught something the tests structurally could not, because the tests
mocked the exact function whose call COUNT was the actual bug.

## Incident 7 -- AggregateError's empty top-level message masked real dispatch errors

**Date:** 2026-09-16

**Expected behavior:** outbox_events.last_error should contain a
diagnostically useful message when a dispatch attempt fails.

**Actual behavior:** last_error was recorded as a genuine, confirmed
non-null EMPTY STRING (verified precisely via
`last_error IS NULL` = false AND `length(last_error)` = 0, disambiguating
from a NULL value) despite 153 real, confirmed dispatch failures.

**Root cause:** Node's net module wraps a connection failure that fails
over both IPv6 (::1) and IPv4 (127.0.0.1) into an AggregateError, whose
top-level .message property is empty BY DESIGN -- the real per-attempt
detail lives in its nested .errors array. The dispatcher's original
catch block did `err.message`, which is correct for ordinary Error
objects but yields "" for this specific error shape. Confirmed via real
captured log output showing the full AggregateError with populated
nested error messages ("connect ECONNREFUSED ::1:5672", "connect
ECONNREFUSED 127.0.0.1:5672").

**Fix:** dispatcher.ts's catch block now checks
`err instanceof AggregateError && err.errors.length > 0` and extracts/
joins the nested messages; falls back to err.message || err.name ||
String(err) otherwise.

**Verification, precisely stated:** The fix was verified via a clean
`npx tsc` and the full test suite (13 suites / 51 tests) still passing
after the change. The corrected last_error TEXT itself was NOT
re-observed against a fresh live RabbitMQ failure in this session --
RabbitMQ recovered within seconds of the API restart that loaded the
fixed code, before another dispatch failure occurred. This gap is
stated explicitly rather than implied as fully empirically confirmed.

**Related gap, now resolved:** during this same edit, two lines from
the original specified implementation (`failed += 1;` and a
`logger.error(...)` call) were not present in the version applied to
disk. This was an observability/diagnostic correctness issue, not a
durability failure -- last_error/attempts/claimed_at were correctly
recorded by markOutboxFailed throughout, which is what actually enables
recovery. The gap meant only that dispatchOutboxBatch's returned failed
count stayed at 0 and no structured per-failure log line fired.
Restored during a Phase 10 corrective pass (see development-log.md):
`failed += 1` and the structured log call were added back to the
existing catch block, and one regression test was added asserting both
the returned count and the underlying DB persistence on a mocked
publish failure. Final suite result: 63/63 tests passing.

**Engineering lesson:** AggregateError is a real, non-obvious JavaScript
error shape (produced by Node's own net module for dual-stack
connection failures) whose default .message is misleading if not
specifically handled -- worth knowing generally, not just for this
project.

## Incident 8 -- Incident 5's failure mode is conditional; the worker exhibits the same pattern (Phase 12 chaos test)

**Date:** 2026-09-28 (Phase 12)

**Environment note:** this chaos test ran against PostgreSQL 16 and
RabbitMQ 3.12, installed directly in this execution environment via
`apt-get`, NOT the project's normal `infra/docker-compose.yml` stack
(RabbitMQ 3.13-management-alpine, postgres:16-alpine, run via
`docker compose`). This execution environment could not reach Docker
Hub (a real, confirmed network-policy denial, not an assumption), so
the containerized stack could not be started. The same
users/database names/credentials/queue topology
docker-compose.yml specifies were configured by hand, and the
behavior described below is believed equivalent -- but this specific
run is NOT evidence about the normal Docker Compose RabbitMQ 3.13
environment, only about this substitute one. Re-running this same
chaos test against the real containerized stack, to confirm the result
transfers, remains an open follow-up. See load-testing.md and
development-log.md's Phase 12 entry for the same note in context.

**Summary of what this incident does and does not claim** (all restated
in more detail below, and cross-referenced against load-testing.md's
full chaos-test walkthrough):
- RabbitMQ was genuinely stopped (`rabbitmqctl stop_app`), not
  simulated.
- The real outbox backlog (pendingOutboxEvents) genuinely accumulated
  while RabbitMQ was down, climbing from 0 to 51 across 51 real
  accepted job submissions.
- A real Phase 12 503 backpressure response was genuinely triggered as
  a direct result (request #52, `pendingOutboxEvents:51`) -- this was
  not forced or pre-arranged; it is the actual, designed behavior of
  BACKPRESSURE_THRESHOLD=50 firing under a real backlog.
- RabbitMQ was then genuinely restarted (`rabbitmqctl start_app`).
- The existing (Phase 2/10, unmodified) API dispatcher/RabbitMQ
  connection did NOT self-recover in this particular failure mode (see
  root cause below) -- this is an EXISTING limitation (Incident 5,
  Phase 6) that Phase 12's chaos test exposed and reproduced under a
  new trigger (a real backlog crossing the new backpressure threshold),
  not a limitation Phase 12 introduced.
- Restarting the API process restored a fresh RabbitMQ connection and
  allowed the backlog to drain fully, automatically, within seconds.
- The worker process independently exhibited the same underlying
  stale-connection pattern (see below) -- also pre-existing, also not
  modified or fixed here.
- **Phase 12 did NOT modify, fix, or otherwise change the worker,
  dispatcher, or outbox architecture, or either connection.ts file** --
  confirmed via `git diff` (see the Phase 12 final report).
- **No exactly-once processing/delivery guarantee, and no automatic-
  recovery guarantee, is being claimed anywhere in this incident or in
  Phase 12's documentation.** The system's existing, repeatedly-stated
  position (see failure-handling.md, engineering-decisions.md) --
  at-least-once delivery, NOT exactly-once, with this specific recovery
  path currently manual -- is unchanged and is what this incident
  reconfirms, not contradicts.

**Trigger:** The Phase 12 backpressure chaos test (see
load-testing.md) -- a genuine RabbitMQ outage against an API/worker
pair that had ALREADY been handling traffic successfully (a real job
had completed end-to-end immediately before the outage began).

**What was expected going in:** Based on Deliberate Test 4 (Phase 10/11,
above), a RabbitMQ outage followed by restart should result in
automatic dispatcher recovery -- that test observed `published_at`
populate within 2 seconds of the next dispatcher tick after RabbitMQ
became healthy again, with no manual intervention.

**What actually happened this time:** After restoring RabbitMQ
(`rabbitmqctl start_app`, confirmed via RabbitMQ's own status output),
`GET /api/health/ready` continued reporting `"rabbitmq":"error"` and
`pendingOutboxEvents` stayed frozen at 51 for over 20 seconds of
polling -- the dispatcher did NOT recover automatically this time,
contradicting the Deliberate Test 4 result at first glance.

**Root cause, reconciling both real observations:** Incident 5's
original root cause (connection.ts's `getChannel()` returns any
non-null cached `channel` without checking liveness) is correct, but
its PRACTICAL failure mode is conditional on the cached `channel`
variable already being non-null at the moment the broker connection
dies:
- **Deliberate Test 4's scenario:** the dispatcher's first-ever publish
  attempt happened DURING the outage (no job had been dispatched by
  that process before RabbitMQ was stopped). Every `getChannel()` call
  during the outage hit `amqp.connect()` fresh, which threw before the
  assignment `connection = await amqp.connect(...)` could complete --
  so `channel`/`connection` stayed `null` throughout. Once RabbitMQ
  returned, the next `getChannel()` call's `amqp.connect()` simply
  succeeded, exactly as it would for any first connection attempt.
  Genuine automatic recovery, correctly observed.
- **This test's scenario:** a channel had ALREADY been successfully
  established and cached (the pre-outage sanity job) before RabbitMQ
  was stopped. `channel` was non-null when the broker force-closed the
  connection, so every subsequent `getChannel()` call -- both during
  the outage AND after RabbitMQ's restart -- returned the SAME stale,
  dead `Channel` object (`if (channel) { return channel; }`, no
  liveness check), which synchronously throws `IllegalOperationError:
  Channel closed` on every `.publish()` call. Restoring RabbitMQ has no
  effect on this: nothing ever re-evaluates whether the cached object
  is still usable.

Both results are real and both are correctly explained by the same root
cause in connection.ts -- they differ only in whether a live channel
happened to be cached at the moment of failure, which depends on
incidental test sequencing, not on anything about RabbitMQ's actual
state. In a long-running production API, a channel is almost always
already cached (successful traffic is the normal case), so THIS test's
scenario -- not Deliberate Test 4's -- is the realistic one to expect
in practice.

**New, related observation (worker side, not previously documented):**
the worker process exhibited the same class of failure independently.
`apps/worker/src/queue/connection.ts` has an identical cache-without-
liveness-check pattern. The worker process itself silently exited
during the outage (no crash log line was written before it stopped --
the process simply ended), and `rabbitmqctl list_queues` confirmed 52
messages sitting `ready` with `0 consumers` even after the API's
dispatcher had successfully republished all of them post-recovery.
Restarting the worker process resolved this immediately.

**Recovery (both times, real):** a process restart (API, then worker)
is what actually resolved each side -- consistent with Incident 5's
already-documented "Current mitigation: None automated. Manual API
process restart is the only recovery path currently available," now
additionally confirmed to apply to the worker process as well.

**Update -- a second real chaos-test execution produced the opposite
dispatcher-recovery result:** This chaos test was re-run once more,
later, against the project's real Docker Compose infrastructure
(PostgreSQL 16, RabbitMQ 3.13-management-alpine, on Windows; against
the same `deadletter` database as the first execution, not
`deadletter_load` -- see load-testing.md, "Execution 2"). The setup matched this incident's
scenario in the relevant respect: a channel had already been used
successfully (jobs had been accepted and completed) before RabbitMQ
was stopped, so a channel was cached going into the outage, not the
Deliberate-Test-4 scenario. **In this execution, after RabbitMQ was
restarted, pendingOutboxEvents drained automatically (51 -> 31 -> 0)
without an API process restart.**

This is a real result, and it is NOT explained by the root-cause theory
above, which predicts that once a channel is cached at the moment of
failure it stays permanently stale until a process restart, regardless
of RabbitMQ's actual state. Two real executions, both with a channel
cached at the moment of outage, produced opposite dispatcher-recovery
outcomes. Possible explanations -- none of them confirmed, all
speculative -- include a difference in exactly which error/close event
fired on the underlying amqplib connection object between a
`rabbitmqctl stop_app`/`start_app` cycle (Execution 1) and however
RabbitMQ was actually stopped/restarted via Docker in Execution 2
(exact command not recorded in the evidence handed to this
documentation pass), or a difference in amqplib's own event behavior
against RabbitMQ 3.12 versus 3.13. **This document does not adopt any
of these explanations -- it records only that the two real, observed
outcomes disagree**, which means the dispatcher's self-recovery
behavior is conditional and not yet fully understood, not simply
"broken" or "fixed." No change has been made to connection.ts or the
dispatcher to investigate or resolve this, per the Phase 12 scope
guard. This remains an open item for a future phase.

The worker's consumer did NOT self-recover in either execution and
required a restart both times -- that part of this incident is
unaffected by this update.

**Not fixed in Phase 12.** Per the explicit Phase 12 scope guard, no
change was made to either connection.ts file, and no reconnection
logic was added anywhere. This incident is documented, not remediated.

**Engineering lesson:** a single successful reproduction of "outage
then recovery" is not sufficient evidence that a recovery path is
reliable -- the SAME root cause can produce different observable
outcomes depending on incidental state (here: whether a channel was
already cached) at the moment of failure. The more realistic case
(cached channel breaks and stays broken) was only surfaced by
deliberately reproducing the outage a second time, in a different
process state, rather than trusting the first successful result as
general proof.

**Update (Phase 14) -- event-listener-driven cache invalidation
implemented:** `apps/api/src/queue/connection.ts` and
`apps/worker/src/queue/connection.ts` now attach `'error'`/`'close'`
listeners to both the connection and the channel at the moment each is
created, nulling the cached references (and emitting a
`connectionEvents` `"invalidated"` event) the instant either one
actually dies -- exactly the fix identified as missing back in Phase 6
("event-listener-driven cache invalidation"). This closes the
structural gap this incident is about: `getChannel()` no longer depends
on the cached `channel` variable happening to already be `null`
(Deliberate Test 4's scenario) for recovery to occur -- it now always
re-evaluates liveness via an explicit signal, regardless of whether a
channel was cached at the moment of failure. On the worker side, since
reconnecting `getChannel()` alone was never enough (the consumer's
`channel.consume()` subscription dies with the channel and nothing
previously re-attached it), `apps/worker/src/consumer.ts` now listens
for that same `"invalidated"` event and resubscribes with a capped
exponential backoff (1s, doubling, capped at 30s) -- closing the "the
worker's consumer did NOT self-recover in either execution" finding
from this incident. An explicit `closingIntentionally` guard in both
connection.ts files prevents this new logic from misfiring during a
normal, intentional shutdown (SIGTERM/SIGINT), which also closes the
channel/connection and would otherwise look identical to a failure.

**What this does and does not resolve:** the fix makes recovery
structurally deterministic (an explicit signal, not incidental amqplib
internal timing) instead of the conditional, unexplained behavior this
incident documented across two real executions. It does NOT explain
why Incident 8's two prior executions disagreed -- that remains an
open, unadopted question, left exactly as recorded above, since the
fix makes the answer moot going forward rather than resolving it
retroactively.

**Validation status (updated -- real evidence obtained):** this fix
has now been verified by (a) a real TypeScript build of both
`apps/api` and `apps/worker`, (b) the three mocked-amqplib unit tests
listed above run for real on the user's Windows environment --
`apps/worker`: 4 suites / 15 tests passed, including both
`connectionRecovery.test.ts` and `consumerResubscribe.test.ts` (after
a test-only synchronization fix to `consumerResubscribe.test.ts`; see
development-log.md's Phase 14 addendum for the reproduction, root
cause, fix and verification of that test bug -- the recovery
implementation itself was not changed), and (c) a real RabbitMQ chaos
test against the actual Docker Compose stack: RabbitMQ was stopped and
restarted, the API and worker processes were **not** restarted, a job
submitted before the outage and a job submitted after recovery both
reached `COMPLETED`, and `GET /api/stats` showed
`pendingOutboxEvents = 0` after recovery. See development-log.md's
Phase 14 addendum for the full result and for why this evidence
specifically rules out the "Deliberate Test 4" false-positive pattern
(no channel ever cached) previously seen in this incident -- a channel
was demonstrably live and in use, having just completed the
pre-outage job, before RabbitMQ was stopped this time. Both real Jest
suites have since passed on the user's Windows environment --
`apps/api`: 18 suites / 82 tests, `apps/worker`: 4 suites / 15 tests --
closing the "apps/api's real Jest results" gap noted earlier in this
validation round. **Still not claimed:** specific recovery
timing/duration or raw structured log-line evidence, since neither was
captured or reported.