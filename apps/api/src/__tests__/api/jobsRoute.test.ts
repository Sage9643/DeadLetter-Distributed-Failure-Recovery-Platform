import request from "supertest";

jest.mock("../../queue/publisher", () => ({
  publishJobCreated: jest.fn().mockResolvedValue(undefined),
}));

import { app } from "../../app";
import { pool } from "../../db/pool";
import { truncateJobs } from "../helpers/testDb";

async function insertJob(status: string, overrides: Partial<{ attempt_count: number }> = {}) {
  const { attempt_count = 0 } = overrides;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO jobs (type, payload, status, attempt_count)
     VALUES ('test_job', '{}'::jsonb, $1, $2)
     RETURNING id`,
    [status, attempt_count]
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
});

describe("GET /api/jobs/:id", () => {
  it("returns 400 for a malformed UUID", async () => {
    const res = await request(app).get("/api/jobs/not-a-uuid");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid job id format" });
  });

  it("returns 404 for a nonexistent UUID", async () => {
    const res = await request(app).get("/api/jobs/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  it("returns 200 with the job for an existing id", async () => {
    const id = await insertJob("COMPLETED");
    const res = await request(app).get(`/api/jobs/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
  });
});

describe("POST /api/jobs/:id/replay", () => {
  it("returns 400 for a malformed UUID", async () => {
    const res = await request(app).post("/api/jobs/not-a-uuid/replay");
    expect(res.status).toBe(400);
  });

  it("returns 404 for a nonexistent UUID", async () => {
    const res = await request(app).post("/api/jobs/00000000-0000-0000-0000-000000000000/replay");
    expect(res.status).toBe(404);
  });

  it("returns 409 when job is COMPLETED", async () => {
    const id = await insertJob("COMPLETED");
    const res = await request(app).post(`/api/jobs/${id}/replay`);
    expect(res.status).toBe(409);
    expect(res.body.currentStatus).toBe("COMPLETED");
  });

  it("returns 409 when job is PROCESSING", async () => {
    const id = await insertJob("PROCESSING");
    const res = await request(app).post(`/api/jobs/${id}/replay`);
    expect(res.status).toBe(409);
    expect(res.body.currentStatus).toBe("PROCESSING");
  });

  it("returns 409 when job is QUEUED", async () => {
    const id = await insertJob("QUEUED");
    const res = await request(app).post(`/api/jobs/${id}/replay`);
    expect(res.status).toBe(409);
    expect(res.body.currentStatus).toBe("QUEUED");
  });

  it("returns 409 when job is RETRYING", async () => {
    const id = await insertJob("RETRYING");
    const res = await request(app).post(`/api/jobs/${id}/replay`);
    expect(res.status).toBe(409);
    expect(res.body.currentStatus).toBe("RETRYING");
  });

  it("returns 200 and QUEUED when job is DEAD_LETTERED", async () => {
    const id = await insertJob("DEAD_LETTERED", { attempt_count: 5 });
    const res = await request(app).post(`/api/jobs/${id}/replay`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("QUEUED");
    expect(res.body.replayCount).toBe(1);
  });
});