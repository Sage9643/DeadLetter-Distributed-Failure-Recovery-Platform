import { pool } from "../../db/pool";
import { truncateJobs } from "../helpers/testDb";
import { dispatchOutboxBatch } from "../../outbox/dispatcher";
import { claimPendingOutboxEvents, markOutboxPublished } from "../../outbox/outboxService";
import { closeConnection } from "../../queue/connection";

async function insertJobAndOutbox() {
  const jobResult = await pool.query<{ id: string }>(
    `INSERT INTO jobs (type, payload) VALUES ('dispatcher_test', '{}'::jsonb) RETURNING id`
  );
  const jobId = jobResult.rows[0]!.id;
  await pool.query(`INSERT INTO outbox_events (job_id) VALUES ($1)`, [jobId]);
  return jobId;
}

beforeEach(async () => {
  await truncateJobs();
});

afterAll(async () => {
  await closeConnection();
  await pool.end();
});

describe("dispatchOutboxBatch (real RabbitMQ)", () => {
  it("publishes a pending event and marks it published", async () => {
    await insertJobAndOutbox();

    const result = await dispatchOutboxBatch(pool);

    expect(result.attempted).toBe(1);
    expect(result.published).toBe(1);
    expect(result.failed).toBe(0);

    const check = await pool.query(`SELECT published_at FROM outbox_events`);
    expect(check.rows[0].published_at).not.toBeNull();
  });

  it("simulates a publisher crash after publish but before marking published -- row remains pending and IS republished on the next attempt", async () => {
    const jobId = await insertJobAndOutbox();

    const claimed = await claimPendingOutboxEvents(pool, 10);
    expect(claimed).toHaveLength(1);

    const publisherModule = await import("../../queue/publisher");
    await publisherModule.publishJobCreated(jobId);

    const preRepublishCheck = await pool.query(`SELECT published_at FROM outbox_events WHERE job_id = $1`, [jobId]);
    expect(preRepublishCheck.rows[0].published_at).toBeNull();

    await pool.query(
      `UPDATE outbox_events SET claimed_at = now() - interval '31 seconds' WHERE job_id = $1`,
      [jobId]
    );

    const result = await dispatchOutboxBatch(pool);
    expect(result.published).toBe(1);

    const finalCheck = await pool.query(`SELECT published_at FROM outbox_events WHERE job_id = $1`, [jobId]);
    expect(finalCheck.rows[0].published_at).not.toBeNull();
  });

  it("increments failed count and leaves row pending on publish error", async () => {
    const jobId = await insertJobAndOutbox();

    const publisherModule = await import("../../queue/publisher");
    const spy = jest
      .spyOn(publisherModule, "publishJobCreated")
      .mockRejectedValueOnce(new Error("simulated publish failure"));

    const result = await dispatchOutboxBatch(pool);

    expect(result.attempted).toBe(1);
    expect(result.published).toBe(0);
    expect(result.failed).toBe(1);

    const check = await pool.query(
      `SELECT published_at, attempts, last_error, claimed_at FROM outbox_events WHERE job_id = $1`,
      [jobId]
    );
    expect(check.rows[0].published_at).toBeNull();
    expect(check.rows[0].attempts).toBe(1);
    expect(check.rows[0].last_error).toBe("simulated publish failure");
    expect(check.rows[0].claimed_at).toBeNull();

    spy.mockRestore();
  });
});