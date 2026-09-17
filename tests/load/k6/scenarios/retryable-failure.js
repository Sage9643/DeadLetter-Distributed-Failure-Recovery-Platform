import { submitJob } from "../lib/helpers.js";

// REAL LOAD SCENARIO -- exercises the EXISTING, UNCHANGED retry policy
// (apps/worker/src/retry/retryPolicy.js: 2s/4s/8s/16s backoff,
// max_attempts=5) and DLQ path at real HTTP-submitted volume. Nothing
// in apps/worker or apps/api is modified by this scenario -- it only
// submits jobs via the existing POST /api/jobs and observes existing
// behavior.
//
// payload.shouldFail=true is the existing deterministic test hook in
// apps/worker/src/processors/jobProcessor.ts (unchanged since Phase 4)
// -- every job created here WILL fail every attempt and is expected to
// exhaust all 5 attempts, reaching DEAD_LETTERED, never COMPLETED.
//
// VOLUME IS DELIBERATELY SMALL AND FIXED (shared-iterations executor,
// not duration-based) -- unlike Scenario B, a duration-based approach
// here could generate an unpredictable number of jobs whose full
// backoff-exhaustion drain time is not yet known. 10 total jobs keeps
// this first run's drain time observable and boundable.
//
// IMPORTANT: this project's worker ACKs a message and becomes free
// again immediately after scheduling a retry -- the backoff delay
// lives in a RabbitMQ retry-queue TTL, not in worker occupancy (see
// consumer.ts). This means N failing jobs do NOT take N times as long
// to drain as a single job would. Actual total drain time for this run
// is NOT predicted here and will be recorded, once measured, in
// docs/load-testing.md -- consistent with this project's standing rule
// against fabricating performance/timing numbers before measuring them.
export const options = {
  scenarios: {
    failing_jobs: {
      executor: "shared-iterations",
      vus: 2,
      iterations: 10,
      maxDuration: "30s",
    },
  },
};

export default function () {
  submitJob("load_test_failing", { shouldFail: true });
}