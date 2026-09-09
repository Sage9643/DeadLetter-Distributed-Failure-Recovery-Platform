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