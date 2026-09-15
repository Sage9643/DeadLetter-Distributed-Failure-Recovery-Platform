import request from "supertest";

jest.mock("../../queue/publisher", () => ({
  publishJobCreated: jest.fn().mockResolvedValue(undefined),
}));

import { app } from "../../app";
import { pool } from "../../db/pool";
import { truncateJobs } from "../helpers/testDb";

beforeEach(async () => {
  await truncateJobs();
});

afterAll(async () => {
  await pool.end();
});

describe("GET /api/jobs", () => {
  it("returns an empty jobs array when there are no jobs", async () => {
    const res = await request(app).get("/api/jobs");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ jobs: [] });
  });

  it("returns created jobs", async () => {
    await request(app).post("/api/jobs").send({ type: "send_email", payload: {} });
    const res = await request(app).get("/api/jobs");
    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(1);
    expect(res.body.jobs[0].type).toBe("send_email");
    expect(res.body.jobs[0].status).toBe("QUEUED");
  });
});