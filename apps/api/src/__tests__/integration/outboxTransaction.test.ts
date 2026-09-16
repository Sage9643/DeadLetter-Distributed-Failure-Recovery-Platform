import { pool } from "../../db/pool";
import { truncateJobs } from "../helpers/testDb";
import { withTransaction } from "../../db/withTransaction";
import { insertOutboxEvent } from "../../outbox/outboxService";
import { createJob } from "../../services/jobService";
import { claimReplay } from "../../services/jobService";

beforeEach(async () => {
  await truncateJobs();
});

afterAll(async () => {
  await pool.end();
});

// Item 1 (partial: job+outbox atomic on success) and item 2
// (transaction rollback), tested directly against the withTransaction
// primitive that both createJob and claimReplay rely on. This is a
// deterministic, direct proof of the actual mechanism -- not reliant on
// forcing createJob's internals to fail via brittle mocking.
describe("withTransaction / insertOutboxEvent atomicity", () => {
  it("commits both the job and its outbox event together on success", async () => {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO jobs (type, payload) VALUES ('commit_test', '{}'::jsonb) RETURNING id`
    );
    const jobId = result.rows[0]!.id;

    await withTransaction(async (client) => {
      await insertOutboxEvent(client, jobId);
    });

    const outboxCheck = await pool.query(`SELECT * FROM outbox_events WHERE job_id = $1`, [jobId]);
    expect(outboxCheck.rows).toHaveLength(1);
    expect(outboxCheck.rows[0].published_at).toBeNull();
  });

  it("rolls back BOTH the job insert and the outbox insert when the transaction fails (item 2)", async () => {
    await expect(
      withTransaction(async (client) => {
        const result = await client.query<{ id: string }>(
          `INSERT INTO jobs (type, payload) VALUES ('rollback_test', '{}'::jsonb) RETURNING id`
        );
        const jobId = result.rows[0]!.id;
        await insertOutboxEvent(client, jobId);
        throw new Error("forced failure to test rollback");
      })
    ).rejects.toThrow("forced failure to test rollback");

    const jobCheck = await pool.query(`SELECT * FROM jobs WHERE type = 'rollback_test'`);
    expect(jobCheck.rows).toHaveLength(0);

    const outboxCheck = await pool.query(
      `SELECT oe.* FROM outbox_events oe JOIN jobs j ON oe.job_id = j.id WHERE j.type = 'rollback_test'`
    );
    expect(outboxCheck.rows).toHaveLength(0);
  });
});

// Item 1 (first part, via the real createJob) and item 7 (replay
// outbox creation semantics).
describe("createJob and claimReplay outbox integration", () => {
  it("createJob atomically creates a job AND a pending outbox event", async () => {
    const job = await createJob({ type: "outbox_create_test", payload: {} });

    const outboxCheck = await pool.query(`SELECT * FROM outbox_events WHERE job_id = $1`, [job.id]);
    expect(outboxCheck.rows).toHaveLength(1);
    expect(outboxCheck.rows[0].published_at).toBeNull();
    expect(outboxCheck.rows[0].attempts).toBe(0);
  });

  it("claimReplay creates an outbox event when the replay succeeds", async () => {
    const insertResult = await pool.query<{ id: string }>(
      `INSERT INTO jobs (type, payload, status, attempt_count) VALUES ('replay_outbox_test', '{}'::jsonb, 'DEAD_LETTERED', 5) RETURNING id`
    );
    const jobId = insertResult.rows[0]!.id;

    const job = await claimReplay(jobId);
    expect(job).not.toBeNull();

    const outboxCheck = await pool.query(`SELECT * FROM outbox_events WHERE job_id = $1`, [jobId]);
    expect(outboxCheck.rows).toHaveLength(1);
  });

  it("claimReplay does NOT create an outbox event when the replay is rejected (item 7, negative case)", async () => {
    const insertResult = await pool.query<{ id: string }>(
      `INSERT INTO jobs (type, payload, status) VALUES ('replay_outbox_reject_test', '{}'::jsonb, 'COMPLETED') RETURNING id`
    );
    const jobId = insertResult.rows[0]!.id;

    const job = await claimReplay(jobId);
    expect(job).toBeNull();

    const outboxCheck = await pool.query(`SELECT * FROM outbox_events WHERE job_id = $1`, [jobId]);
    expect(outboxCheck.rows).toHaveLength(0);
  });
});