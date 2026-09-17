import { sleep } from "k6";
import { submitJob } from "../lib/helpers.js";

// HARNESS SMOKE TEST ONLY -- not a performance/load benchmark.
//
// This run validates, and ONLY validates:
//   - k6 is installed and executable
//   - K6_BASE_URL is explicitly configured (no default target)
//   - real HTTP connectivity to the API
//   - the full API -> PostgreSQL -> RabbitMQ -> worker path completes
//     end to end under real (if trivial) concurrent load
//   - deadletter_load is genuinely isolated from deadletter/deadletter_test
//   - the verifyDb.js DB-verification harness itself works correctly
//
// vus:2/duration:10s is intentionally small. Its resulting
// latency/throughput numbers MUST NOT be recorded or cited anywhere as
// a meaningful performance benchmark -- see docs/load-testing.md. Real
// load-level scenarios come later, once this harness is proven correct.
export const options = {
  vus: 2,
  duration: "10s",
};

export default function () {
  submitJob("load_test_normal", {});
  sleep(1);
}