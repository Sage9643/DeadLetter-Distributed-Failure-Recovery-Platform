import { pool } from "../../db/pool";
import { truncateJobs } from "../helpers/testDb";
import { getStats } from "../../services/statsService";

async function insertJob(status: string, overrides: Partial<{ replay_count: number; total_attempt_count: number }> = {}) {
  const { replay_count = 0, total_attempt_count = 0 } = overrides;
  await pool.query(
    `INSERT INTO jobs (type, payload, status, replay_count, total_attempt_count)
     VALUES ('test_job', '{}'::jsonb, $1, $2, $3)`,
    [status, replay_count, total_attempt_count]
  );
}

beforeEach(async () => {
  await truncateJobs();
});

afterAll(async () => {
  await pool.end();
});

describe("getStats", () => {
  it("returns all zeros for an empty jobs table", async () => {
    const stats = await getStats();
    expect(stats.totalJobs).toBe(0);
    expect(stats.byStatus).toEqual({
      QUEUED: 0,
      PROCESSING: 0,
      COMPLETED: 0,
      FAILED: 0,
      RETRYING: 0,
      DEAD_LETTERED: 0,
    });
    expect(stats.totalReplays).toBe(0);
    expect(stats.totalAttempts).toBe(0);
  });

  it("returns accurate counts for a known seeded state", async () => {
    await insertJob("QUEUED");
    await insertJob("QUEUED");
    await insertJob("PROCESSING");
    await insertJob("COMPLETED", { total_attempt_count: 1 });
    await insertJob("COMPLETED", { total_attempt_count: 6, replay_count: 1 });
    await insertJob("RETRYING", { total_attempt_count: 2 });
    await insertJob("DEAD_LETTERED", { total_attempt_count: 5 });
    await insertJob("FAILED", { total_attempt_count: 1 });

    const stats = await getStats();

    expect(stats.totalJobs).toBe(8);
    expect(stats.byStatus).toEqual({
      QUEUED: 2,
      PROCESSING: 1,
      COMPLETED: 2,
      FAILED: 1,
      RETRYING: 1,
      DEAD_LETTERED: 1,
    });
    expect(stats.totalReplays).toBe(1);
    expect(stats.totalAttempts).toBe(15);
  });
});