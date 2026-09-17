import { submitJob } from "../lib/helpers.js";

// REAL LOAD SCENARIO, RUN DELIBERATELY WHILE RABBITMQ IS STOPPED.
//
// This script itself does NOT stop/start RabbitMQ -- that is done
// manually via `docker compose stop/start rabbitmq` (from infra/),
// the exact same commands already proven safe in Phase 2's Deliberate
// Test 2, Phase 6's Deliberate Test 3, and Phase 10's Deliberate Test
// 4. See docs/load-testing.md for the exact required sequence.
//
// Volume is small and fixed (shared-iterations, not duration-based) --
// this scenario's purpose is proving backlog DURABILITY and RECOVERY,
// not generating maximum submission pressure (that is Scenario B's
// job). Every job here is a NORMAL job (no shouldFail) -- the point is
// the outbox's publish-retry behavior, not the worker's retry policy
// (that is Scenario C's job).
//
// EXPECT POST /api/jobs to keep returning 201 throughout the outage --
// this is the core Phase 10 guarantee being exercised at k6-generated
// volume, not re-derived from scratch (already proven with one job by
// hand in Phase 10's Deliberate Test 4).
export const options = {
  scenarios: {
    outage_submission: {
      executor: "shared-iterations",
      vus: 2,
      iterations: 10,
      maxDuration: "30s",
    },
  },
};

export default function () {
  submitJob("load_test_outage", {});
}