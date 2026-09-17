import { submitJob } from "../lib/helpers.js";

// REAL LOAD SCENARIO -- metrics from this run ARE meaningful, unlike
// scenario (a)'s harness smoke test.
//
// Deliberately NO sleep() between iterations (unlike scenario (a)'s
// paced ~1/VU/sec) -- 10 VUs hammer the API back-to-back for the full
// duration, generating genuine concurrent submission pressure rather
// than simulated pacing.
//
// EXPECT a much larger job count than scenario (a)'s 20 -- likely
// several hundred, depending on real observed API latency. The worker
// needs real time AFTER this k6 run finishes to drain that backlog;
// verifyDb.js's concurrent mode will correctly report FAIL if checked
// too early -- re-run it after waiting, per its own printed guidance.
//
// Correctness focus: every job must reach COMPLETED with
// attempt_count === 1 (no double-claim under concurrent load) -- see
// verifyDb.js's verifyConcurrentSubmission().
export const options = {
  vus: 10,
  duration: "20s",
};

export default function () {
  submitJob("load_test_concurrent", {});
}