import request from "supertest";

jest.mock("../../queue/publisher", () => ({
  publishJobCreated: jest.fn().mockResolvedValue(undefined),
}));

import { app } from "../../app";
import { pool } from "../../db/pool";
import { truncateJobs } from "../helpers/testDb";
import { env } from "../../config/env";

// This suite exercises backpressure through the REAL app / REAL
// POST /api/jobs route, against the REAL env.BACKPRESSURE_THRESHOLD
// (50 by default -- see config/env.ts), using deterministically-seeded
// real Postgres rows rather than a mocked getStats(). Per the locked
// Phase 12 design: "deterministically create a pending-outbox state" and
// verify the actual route behavior, not the middleware in isolation
// (that responsibility -- generic admission logic -- belongs to
// rateLimiter's own unit tests; this file is specifically about the
// DeadLetter-specific pendingOutboxEvents signal wired into a real route).

async function insertJobWithPendingOutboxEvent(): Promise<string> {
  const jobResult = await pool.query<{ id: string }>(
    `INSERT INTO jobs (type, payload, status) VALUES ('backpressure_seed', '{}'::jsonb, 'QUEUED') RETURNING id`
  );
  const jobId = jobResult.rows[0]?.id;
  if (!jobId) throw new Error("insertJobWithPendingOutboxEvent: no job id returned");
  await pool.query(`INSERT INTO outbox_events (job_id) VALUES ($1)`, [jobId]);
  return jobId;
}

async function seedPendingOutboxEvents(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await insertJobWithPendingOutboxEvent();
  }
}

async function countRows(table: "jobs" | "outbox_events"): Promise<number> {
  const result = await pool.query<{ count: string }>(`SELECT COUNT(*) as count FROM ${table}`);
  return Number(result.rows[0]?.count ?? 0);
}

async function markAllOutboxPublished(): Promise<void> {
  await pool.query(`UPDATE outbox_events SET published_at = now() WHERE published_at IS NULL`);
}

beforeEach(async () => {
  await truncateJobs();
});

afterAll(async () => {
  await pool.end();
});

describe("POST /api/jobs backpressure (real threshold: env.BACKPRESSURE_THRESHOLD)", () => {
  it(`sanity: env.BACKPRESSURE_THRESHOLD is the expected default (50) for this suite's assertions`, () => {
    expect(env.BACKPRESSURE_THRESHOLD).toBe(50);
  });

  it("pendingOutboxEvents <= threshold: request proceeds normally (201)", async () => {
    await seedPendingOutboxEvents(env.BACKPRESSURE_THRESHOLD); // exactly at threshold, not over it
    const before = await countRows("jobs");

    const res = await request(app)
      .post("/api/jobs")
      .send({ type: "normal_job", payload: {} });

    expect(res.status).toBe(201);
    const after = await countRows("jobs");
    expect(after).toBe(before + 1);
  });

  it("pendingOutboxEvents > threshold: returns 503 with the actual pending count and Retry-After=5", async () => {
    const seedCount = env.BACKPRESSURE_THRESHOLD + 1;
    await seedPendingOutboxEvents(seedCount);

    const res = await request(app)
      .post("/api/jobs")
      .send({ type: "should_be_rejected", payload: {} });

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: "Service temporarily unable to accept new jobs",
      reason: "backpressure",
      pendingOutboxEvents: seedCount,
    });
    expect(res.headers["retry-after"]).toBe("5");
  });

  it("a rejected request creates ZERO new job rows and ZERO new outbox_events rows", async () => {
    const seedCount = env.BACKPRESSURE_THRESHOLD + 1;
    await seedPendingOutboxEvents(seedCount);

    const jobsBefore = await countRows("jobs");
    const outboxBefore = await countRows("outbox_events");

    const res = await request(app)
      .post("/api/jobs")
      .send({ type: "should_be_rejected", payload: {} });

    expect(res.status).toBe(503);

    const jobsAfter = await countRows("jobs");
    const outboxAfter = await countRows("outbox_events");

    expect(jobsAfter).toBe(jobsBefore);
    expect(outboxAfter).toBe(outboxBefore);
  });

  it("after the backlog clears (all pending outbox events marked published), POST /api/jobs resumes normally", async () => {
    const seedCount = env.BACKPRESSURE_THRESHOLD + 1;
    await seedPendingOutboxEvents(seedCount);

    const rejected = await request(app)
      .post("/api/jobs")
      .send({ type: "should_be_rejected", payload: {} });
    expect(rejected.status).toBe(503);

    await markAllOutboxPublished();

    const jobsBefore = await countRows("jobs");
    const resumed = await request(app)
      .post("/api/jobs")
      .send({ type: "should_succeed_now", payload: {} });

    expect(resumed.status).toBe(201);
    const jobsAfter = await countRows("jobs");
    expect(jobsAfter).toBe(jobsBefore + 1);
  });

  it("does NOT apply backpressure to POST /api/jobs/:id/replay, even with the backlog well over threshold", async () => {
    const seedCount = env.BACKPRESSURE_THRESHOLD + 1;
    await seedPendingOutboxEvents(seedCount);

    const deadLetteredResult = await pool.query<{ id: string }>(
      `INSERT INTO jobs (type, payload, status, attempt_count) VALUES ('replay_target', '{}'::jsonb, 'DEAD_LETTERED', 5) RETURNING id`
    );
    const jobId = deadLetteredResult.rows[0]?.id;
    if (!jobId) throw new Error("no job id returned");

    const res = await request(app).post(`/api/jobs/${jobId}/replay`);

    // Must NOT be the backpressure 503 -- replay is explicitly exempt.
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("QUEUED");
  });
});
