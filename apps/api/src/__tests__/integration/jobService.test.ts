import { pool } from "../../db/pool";
import { truncateJobs } from "../helpers/testDb";
import { claimReplay, getJobById } from "../../services/jobService";

async function insertJob(overrides: Partial<{ status: string; type: string; attempt_count: number; replay_count: number }> = {}) {
  const { status = "DEAD_LETTERED", type = "test_job", attempt_count = 5, replay_count = 0 } = overrides;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO jobs (type, payload, status, attempt_count, replay_count)
     VALUES ($1, '{}'::jsonb, $2, $3, $4)
     RETURNING id`,
    [type, status, attempt_count, replay_count]
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

describe("claimReplay concurrency (real PostgreSQL atomic replay claim)", () => {
  it("allows exactly one of two concurrent replay claims to succeed", async () => {
    const jobId = await insertJob({ status: "DEAD_LETTERED", attempt_count: 5 });

    const [resultA, resultB] = await Promise.all([claimReplay(jobId), claimReplay(jobId)]);

    const succeeded = [resultA, resultB].filter((r) => r !== null);
    const failed = [resultA, resultB].filter((r) => r === null);

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);

    const final = await getJobById(jobId);
    expect(final?.status).toBe("QUEUED");
    expect(final?.attempt_count).toBe(0);
    expect(final?.replay_count).toBe(1);
  });

  it("returns null and makes no change for a job that is not DEAD_LETTERED", async () => {
    const jobId = await insertJob({ status: "COMPLETED" });
    const result = await claimReplay(jobId);
    expect(result).toBeNull();
    const job = await getJobById(jobId);
    expect(job?.status).toBe("COMPLETED");
    expect(job?.replay_count).toBe(0);
  });
});