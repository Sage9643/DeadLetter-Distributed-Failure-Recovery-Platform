import request from "supertest";

jest.mock("../../queue/publisher", () => ({
  publishJobCreated: jest.fn().mockResolvedValue(undefined),
}));

import { app } from "../../app";
import { pool } from "../../db/pool";
import { truncateJobs } from "../helpers/testDb";
import { env } from "../../config/env";

// Complements rateLimiter.test.ts / rateLimiter.concurrency.test.ts (which
// exercise the middleware directly against mock req/res). This file proves
// the SAME admission invariant end-to-end through the real Express app and
// a real Postgres database, specifically to verify the locked-design
// invariant: "rejected requests do not reach createJob() / ZERO resulting
// database writes" -- something a mock req/res cannot demonstrate, since
// there is no real createJob()/DB to observe.
//
// Uses a distinct X-Test-Client-Id per test (NODE_ENV=test, per .env.test)
// so this file's requests don't share a bucket with any other test file's
// traffic against the same route -- consistent with how jobsRouter wires
// ONE shared rate limiter instance module-wide.

async function countJobs(): Promise<number> {
  const result = await pool.query<{ count: string }>(`SELECT COUNT(*) as count FROM jobs`);
  return Number(result.rows[0]?.count ?? 0);
}

// No outbox dispatcher runs against this test app (app.ts never starts
// one -- only index.ts does, see Phase 10). Left alone, every real
// POST /api/jobs in this file accumulates a permanently-unpublished
// outbox_events row, and this suite intentionally drives well past 50
// such rows to test the RATE limiter's capacity=100 boundary. Without
// draining them, env.BACKPRESSURE_THRESHOLD (50) fires first and this
// file would actually be testing backpressure, not rate limiting -- a
// real interaction discovered while writing this test (see
// docs/engineering-decisions.md / development-log.md Phase 12 notes).
// This helper simulates what the real dispatcher does (mark published)
// so this file isolates rate-limiting behavior specifically.
async function drainOutboxBacklog(): Promise<void> {
  await pool.query(`UPDATE outbox_events SET published_at = now() WHERE published_at IS NULL`);
}

beforeEach(async () => {
  await truncateJobs();
});

afterAll(async () => {
  await pool.end();
});

describe("POST /api/jobs rate limiting (real route, real DB, env.RATE_LIMIT_CAPACITY)", () => {
  it(`sanity: env.RATE_LIMIT_CAPACITY/WINDOW are the expected defaults for this suite's assertions`, () => {
    expect(env.RATE_LIMIT_CAPACITY).toBe(100);
    expect(env.RATE_LIMIT_WINDOW_SECONDS).toBe(60);
  });

  it(
    "admits at most RATE_LIMIT_CAPACITY (+ real measured wall-clock refill) requests, rejects the overshoot with 429, and every rejection creates ZERO job rows",
    async () => {
      // NOTE on why this isn't "admits EXACTLY capacity, then the very
      // next call is 429": the production limiter (routes/jobs.ts) uses
      // the real system clock (createRateLimiter is called with no `now`
      // override), and tokens refill CONTINUOUSLY, not once per window.
      // Sending `capacity` sequential real HTTP+DB requests takes
      // non-zero wall-clock time, during which a fraction of a token has
      // already regenerated -- discovered as a genuine first-run failure
      // while writing this test (see development-log.md, Phase 12): the
      // 101st request returned 201, not 429, because ~1-2 tokens had
      // already refilled during the ~1s it took to send 100 requests.
      // The deterministic EXACT-boundary proof (capacity admitted, the
      // very next rejected, with a frozen clock) is rateLimiter.test.ts's
      // job, not this file's -- this file proves the real end-to-end
      // route + DB-write invariant under real elapsed time instead.
      const clientId = "rate-limit-route-test-client";
      const capacity = env.RATE_LIMIT_CAPACITY;
      const windowMs = env.RATE_LIMIT_WINDOW_SECONDS * 1000;
      const refillPerMs = capacity / windowMs;
      const overshoot = 30; // comfortably more than any realistic refill during this loop

      const startMs = Date.now();
      let admitted = 0;
      let firstRejectionSeen = false;

      for (let i = 0; i < capacity + overshoot; i++) {
        const res = await request(app)
          .post("/api/jobs")
          .set("X-Test-Client-Id", clientId)
          .send({ type: "rate_limit_test", payload: { i } });

        if (res.status === 201) {
          admitted += 1;
          await drainOutboxBacklog(); // keep pendingOutboxEvents low so backpressure never interferes
        } else {
          firstRejectionSeen = true;
          expect(res.status).toBe(429);
          expect(res.body).toEqual({ error: "Too many requests", reason: "rate_limited" });
          expect(res.headers["retry-after"]).toBeDefined();
        }
      }
      const endMs = Date.now();

      expect(firstRejectionSeen).toBe(true);

      // Upper bound derived from ACTUAL measured elapsed time, not a
      // fabricated constant: capacity plus however many tokens could
      // genuinely have refilled during this real loop, plus 1 for
      // rounding/measurement slack.
      const maxPossibleAdmitted = capacity + Math.ceil((endMs - startMs) * refillPerMs) + 1;
      expect(admitted).toBeGreaterThanOrEqual(capacity);
      expect(admitted).toBeLessThanOrEqual(maxPossibleAdmitted);

      const jobsInDb = await countJobs();
      expect(jobsInDb).toBe(admitted); // every 201 has exactly one job row; every 429 has zero
    },
    60000
  );

  it("rate limits POST /:id/replay through the SAME shared bucket as POST / (one client, mixed traffic)", async () => {
    const clientId = "rate-limit-route-shared-bucket-client";

    // Seed one DEAD_LETTERED job to replay against.
    const seeded = await pool.query<{ id: string }>(
      `INSERT INTO jobs (type, payload, status, attempt_count) VALUES ('replay_seed', '{}'::jsonb, 'DEAD_LETTERED', 5) RETURNING id`
    );
    const jobId = seeded.rows[0]?.id;
    if (!jobId) throw new Error("no job id returned");

    // Use a tiny capacity for this test via a fresh client identity plus
    // enough real requests split across BOTH routes to prove they draw
    // from the same 100-token budget, not two independent 100-token
    // budgets. 60 create + 41 replay-attempts = 101 total > capacity 100.
    for (let i = 0; i < 60; i++) {
      const res = await request(app)
        .post("/api/jobs")
        .set("X-Test-Client-Id", clientId)
        .send({ type: "shared_bucket_test", payload: { i } });
      expect(res.status).toBe(201);
      await drainOutboxBacklog(); // keep pendingOutboxEvents low so backpressure never interferes
    }

    let sawRejection = false;
    for (let i = 0; i < 60; i++) {
      const res = await request(app)
        .post(`/api/jobs/${jobId}/replay`)
        .set("X-Test-Client-Id", clientId);
      // Every one of these replay attempts after the first is expected to
      // be a 409 (job no longer DEAD_LETTERED after the first succeeds) --
      // that is a DIFFERENT concern (replay state machine) from rate
      // limiting, so both 200/409 count as "admitted past the limiter".
      if (res.status === 429) {
        sawRejection = true;
        expect(res.body).toEqual({ error: "Too many requests", reason: "rate_limited" });
        break;
      }
      expect([200, 409]).toContain(res.status);
    }

    expect(sawRejection).toBe(true);
  }, 30000);
});
