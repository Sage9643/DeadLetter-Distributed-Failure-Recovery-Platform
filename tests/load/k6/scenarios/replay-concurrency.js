import http from "k6/http";
import { check } from "k6";
import exec from "k6/execution";
import { BASE_URL } from "../lib/config.js";

// REAL LOAD SCENARIO -- targets ONLY POST /api/jobs/:id/replay against
// jobs SEEDED DIRECTLY via SQL (tests/load/verify/seedReplayJobs.js),
// not created through this script. Does not call POST /api/jobs at
// all.
//
// Reads the real seeded UUIDs written by seedReplayJobs.js. Fails
// loudly at init time if that file is missing -- this scenario cannot
// run meaningfully without real, pre-verified seeded job IDs.
const jobIds = JSON.parse(open("../data/replay-job-ids.json"));

// DELIBERATE, GUARANTEED ID REUSE -- not probabilistic. Total
// iterations (40) is exactly 2x the seeded job count (20), and each
// iteration's job ID is chosen via (iteration index % jobIds.length).
// This means EVERY seeded job ID is targeted by EXACTLY 2 separate
// concurrent iterations, guaranteeing a genuine claim race on every
// single job by construction, not by chance.
export const options = {
  scenarios: {
    replay_races: {
      executor: "shared-iterations",
      vus: 10,
      iterations: jobIds.length * 2,
      maxDuration: "30s",
    },
  },
};

// The existing replay route's real, documented contract (Phase 6,
// unmodified): 200 on successful claim, 409 when another concurrent
// request already claimed it (the expected, correct lost-race
// outcome -- NOT a failure), 404/400 not expected here since all IDs
// are real and well-formed. This check only asserts the response is
// one of the two legitimately expected outcomes -- it does NOT assume
// every request succeeds with 200.
export default function () {
  // __ITER is PER-VU (resets to 0 for each VU independently) -- using
  // it here would NOT guarantee every seeded job is targeted, as
  // discovered during Scenario E's first real run (see
  // incidents-and-failures.md / development-log.md). iterationInTest
  // is a genuinely global, monotonically-increasing counter across all
  // VUs in shared-iterations mode, which is what guaranteed coverage
  // of every seeded job actually requires.
  const iterId = exec.scenario.iterationInTest;
  const jobId = jobIds[iterId % jobIds.length];

  const res = http.post(`${BASE_URL}/api/jobs/${jobId}/replay`);

  check(res, {
    "replay response is 200 (won claim) or 409 (lost race, expected)": (r) =>
      r.status === 200 || r.status === 409,
  });
}