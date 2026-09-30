// Focused regression test for verify-ws.js's job-ID extraction.
//
// This is what actually broke in real production validation (Phase
// 17 addendum): the script read `created.id` from the job creation
// response, but POST /api/jobs responds with { jobId, status } (see
// apps/api/src/routes/jobs.ts) -- there is no top-level `id` field.
// `created.id` was always undefined, so every WS message match
// (m.jobId === jobId) compared against undefined and could never
// succeed, even though the WebSocket path itself was working
// correctly (the real run showed both QUEUED and COMPLETED
// job.updated events being broadcast for the real job).
//
// Uses Node's built-in test runner (node:test / node:assert) --
// deliberately not Jest: this script lives under apps/api/scripts/,
// outside apps/api's Jest `src/__tests__` root, and pulling it into
// the Jest suite would mean changing Jest's config/roots for a
// two-function standalone script. Run directly with:
//   node --test apps/api/scripts/__tests__/extractJobId.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const { extractJobId } = require("../verify-ws");

test("extractJobId reads the real POST /api/jobs response shape ({ jobId, status })", () => {
  const realResponseShape = { jobId: "fc7b9a30-4cb8-40e8-9760-6c58072d79f0", status: "QUEUED" };
  assert.equal(extractJobId(realResponseShape), "fc7b9a30-4cb8-40e8-9760-6c58072d79f0");
});

test("extractJobId returns undefined for the WRONG shape that caused the real bug ({ id, ... })", () => {
  // This is exactly the assumption the script used to make. Asserting
  // it now returns undefined (not throws, not a stale/fabricated
  // value) documents the regression this fix targets and would fail
  // this test again if anyone reintroduces `created.id`.
  const wrongShapeThatCausedTheBug = { id: "fc7b9a30-4cb8-40e8-9760-6c58072d79f0", status: "QUEUED" };
  assert.equal(extractJobId(wrongShapeThatCausedTheBug), undefined);
});

test("extractJobId returns undefined for a null/empty response body without throwing", () => {
  assert.equal(extractJobId(null), null);
  assert.equal(extractJobId(undefined), undefined);
  assert.equal(extractJobId({}), undefined);
});
