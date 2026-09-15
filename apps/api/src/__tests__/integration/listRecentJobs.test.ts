import { pool } from "../../db/pool";
import { truncateJobs } from "../helpers/testDb";
import { listRecentJobs } from "../../services/jobService";

async function insertJob(type: string, status: string) {
  await pool.query(`INSERT INTO jobs (type, payload, status) VALUES ($1, '{}'::jsonb, $2)`, [type, status]);
}

beforeEach(async () => {
  await truncateJobs();
});

afterAll(async () => {
  await pool.end();
});

describe("listRecentJobs", () => {
  it("returns an empty array when there are no jobs", async () => {
    const jobs = await listRecentJobs();
    expect(jobs).toEqual([]);
  });

  it("orders by updated_at descending and limits to 20", async () => {
    for (let i = 0; i < 25; i++) {
      await insertJob(`job_${i}`, "QUEUED");
    }
    const jobs = await listRecentJobs();
    expect(jobs).toHaveLength(20);
  });

  it("returns only the documented fields", async () => {
    await insertJob("send_email", "COMPLETED");
    const jobs = await listRecentJobs();
    expect(jobs).toHaveLength(1);
    expect(Object.keys(jobs[0]!).sort()).toEqual(
      ["id", "type", "status", "attempt_count", "max_attempts", "created_at", "updated_at"].sort()
    );
  });
});