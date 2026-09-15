import { pool } from "../../db/pool";
import { truncateJobs } from "../helpers/testDb";
import {
  claimJob,
  markCompleted,
  markRetrying,
  markDeadLettered,
  getJobById,
} from "../../services/jobService";

async function insertJob(overrides: Partial<{ status: string; type: string; attempt_count: number; max_attempts: number }> = {}) {
  const { status = "QUEUED", type = "test_job", attempt_count = 0, max_attempts = 5 } = overrides;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO jobs (type, payload, status, attempt_count, max_attempts)
     VALUES ($1, '{}'::jsonb, $2, $3, $4)
     RETURNING id`,
    [type, status, attempt_count, max_attempts]
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

describe("claimJob concurrency (real PostgreSQL atomic claim)", () => {
  it("allows exactly one of two concurrent claims to succeed", async () => {
    const jobId = await insertJob({ status: "QUEUED" });

    const [resultA, resultB] = await Promise.all([claimJob(jobId), claimJob(jobId)]);

    const succeeded = [resultA, resultB].filter((r) => r !== null);
    const failed = [resultA, resultB].filter((r) => r === null);

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);

    const final = await getJobById(jobId);
    expect(final?.status).toBe("PROCESSING");
    expect(final?.attempt_count).toBe(1);
    expect(final?.total_attempt_count).toBe(1);
  });
});

describe("state-machine preconditions", () => {
  it("markCompleted succeeds when status is PROCESSING", async () => {
    const jobId = await insertJob({ status: "PROCESSING" });
    const result = await markCompleted(jobId);
    expect(result.status).toBe("COMPLETED");
  });

  it("markCompleted throws and does not mutate when status is not PROCESSING", async () => {
    const jobId = await insertJob({ status: "QUEUED" });
    await expect(markCompleted(jobId)).rejects.toThrow();
    const job = await getJobById(jobId);
    expect(job?.status).toBe("QUEUED");
  });

  it("markRetrying succeeds when status is PROCESSING", async () => {
    const jobId = await insertJob({ status: "PROCESSING" });
    const result = await markRetrying(jobId, "some error");
    expect(result.status).toBe("RETRYING");
    expect(result.last_error).toBe("some error");
  });

  it("markRetrying throws and does not mutate when status is not PROCESSING", async () => {
    const jobId = await insertJob({ status: "DEAD_LETTERED" });
    await expect(markRetrying(jobId, "x")).rejects.toThrow();
    const job = await getJobById(jobId);
    expect(job?.status).toBe("DEAD_LETTERED");
  });

  it("markDeadLettered succeeds when status is PROCESSING", async () => {
    const jobId = await insertJob({ status: "PROCESSING" });
    const result = await markDeadLettered(jobId, "boom");
    expect(result.status).toBe("DEAD_LETTERED");
    expect(result.last_dead_lettered_at).not.toBeNull();
    expect(result.last_dead_letter_reason).toBe("boom");
  });

  it("markDeadLettered throws and does not mutate when status is not PROCESSING", async () => {
    const jobId = await insertJob({ status: "COMPLETED" });
    await expect(markDeadLettered(jobId, "x")).rejects.toThrow();
    const job = await getJobById(jobId);
    expect(job?.status).toBe("COMPLETED");
  });
});