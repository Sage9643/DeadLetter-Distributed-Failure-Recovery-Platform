// Phase 16: end-to-end proof (real Express app via supertest, real
// Postgres for the replay fixture) that the public security baseline
// actually holds at the route level, not just inside the isolated
// requireApiKey unit tests (unit/auth.test.ts). API_KEY is set on
// process.env BEFORE any import of ../../app/../../config/env below,
// so this file's own module registry (Jest isolates modules per test
// file) loads env.ts with a real, non-empty API_KEY -- exercising the
// exact "key configured, must be checked" branch, complementary to
// the rest of this suite (which runs with no API_KEY set at all, the
// dev/test fallback).

process.env.API_KEY = "integration-test-secret";

import request from "supertest";

jest.mock("../../queue/publisher", () => ({
  publishJobCreated: jest.fn().mockResolvedValue(undefined),
}));

import { app } from "../../app";
import { pool } from "../../db/pool";
import { truncateJobs } from "../helpers/testDb";

async function insertJob(status: string) {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO jobs (type, payload, status, attempt_count)
     VALUES ('test_job', '{}'::jsonb, $1, 5)
     RETURNING id`,
    [status]
  );
  const row = result.rows[0];
  if (!row) throw new Error("insertJob: no row returned");
  return row.id;
}

beforeEach(async () => {
  await truncateJobs();
});

afterAll(async () => {
  await pool.end();
  delete process.env.API_KEY;
});

describe("public security baseline: API key enforcement at the route level (Phase 16)", () => {
  it("GET /api/jobs remains public (no auth required) even though API_KEY is configured", async () => {
    const res = await request(app).get("/api/jobs");
    expect(res.status).toBe(200);
  });

  it("GET /api/stats remains public (no auth required) even though API_KEY is configured", async () => {
    const res = await request(app).get("/api/stats");
    expect(res.status).toBe(200);
  });

  it("GET /api/jobs/:id remains public (no auth required) even though API_KEY is configured", async () => {
    const id = await insertJob("COMPLETED");
    const res = await request(app).get(`/api/jobs/${id}`);
    expect(res.status).toBe(200);
  });

  it("POST /api/jobs is rejected with 401 when no API key header is provided", async () => {
    const res = await request(app).post("/api/jobs").send({ type: "t", payload: {} });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized", reason: "missing_or_invalid_api_key" });
  });

  it("POST /api/jobs is rejected with 401 when the wrong API key header is provided", async () => {
    const res = await request(app)
      .post("/api/jobs")
      .set("x-api-key", "wrong-key")
      .send({ type: "t", payload: {} });
    expect(res.status).toBe(401);
  });

  it("POST /api/jobs succeeds (201) with the correct API key header", async () => {
    const res = await request(app)
      .post("/api/jobs")
      .set("x-api-key", "integration-test-secret")
      .send({ type: "t", payload: {} });
    expect(res.status).toBe(201);
  });

  it("POST /api/jobs/:id/replay is rejected with 401 when no API key header is provided", async () => {
    const id = await insertJob("DEAD_LETTERED");
    const res = await request(app).post(`/api/jobs/${id}/replay`);
    expect(res.status).toBe(401);
  });

  it("POST /api/jobs/:id/replay succeeds with the correct API key header", async () => {
    const id = await insertJob("DEAD_LETTERED");
    const res = await request(app)
      .post(`/api/jobs/${id}/replay`)
      .set("x-api-key", "integration-test-secret");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("QUEUED");
  });
});
