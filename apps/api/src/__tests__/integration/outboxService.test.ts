import { pool } from "../../db/pool";
import { truncateJobs } from "../helpers/testDb";
import {
  claimPendingOutboxEvents,
  markOutboxPublished,
  markOutboxFailed,
  countPendingOutboxEvents,
} from "../../outbox/outboxService";

async function insertJobAndOutbox(): Promise<string> {
  const jobResult = await pool.query<{ id: string }>(
    `INSERT INTO jobs (type, payload) VALUES ('outbox_svc_test', '{}'::jsonb) RETURNING id`
  );
  const jobId = jobResult.rows[0]!.id;
  await pool.query(`INSERT INTO outbox_events (job_id) VALUES ($1)`, [jobId]);
  return jobId;
}

beforeEach(async () => {
  await truncateJobs();
});

afterAll(async () => {
  await pool.end();
});

describe("claimPendingOutboxEvents", () => {
  it("claims a freshly-inserted pending row", async () => {
    await insertJobAndOutbox();
    const claimed = await claimPendingOutboxEvents(pool, 10);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.claimed_at).not.toBeNull();
  });

  it("does NOT reclaim a row claimed recently (within the staleness window)", async () => {
    await insertJobAndOutbox();
    await claimPendingOutboxEvents(pool, 10);

    const secondClaim = await claimPendingOutboxEvents(pool, 10);
    expect(secondClaim).toHaveLength(0);
  });

  it("DOES reclaim a row whose claim is stale (> 30s old, deterministically backdated via SQL)", async () => {
    const jobId = await insertJobAndOutbox();

    await pool.query(
      `UPDATE outbox_events SET claimed_at = now() - interval '31 seconds' WHERE job_id = $1`,
      [jobId]
    );

    const reclaimed = await claimPendingOutboxEvents(pool, 10);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]!.job_id).toBe(jobId);
  });

  it("marks a claimed event published, removing it from future pending claims", async () => {
    await insertJobAndOutbox();
    const claimed = await claimPendingOutboxEvents(pool, 10);
    await markOutboxPublished(pool, claimed[0]!.id);

    const pendingCount = await countPendingOutboxEvents(pool);
    expect(pendingCount).toBe(0);
  });

  it("marking failed resets claimed_at and increments attempts, making it immediately reclaimable", async () => {
    await insertJobAndOutbox();
    const claimed = await claimPendingOutboxEvents(pool, 10);
    await markOutboxFailed(pool, claimed[0]!.id, "simulated RabbitMQ error");

    const reclaimResult = await pool.query(
      `SELECT attempts, last_error, claimed_at FROM outbox_events WHERE id = $1`,
      [claimed[0]!.id]
    );
    expect(reclaimResult.rows[0].attempts).toBe(1);
    expect(reclaimResult.rows[0].last_error).toBe("simulated RabbitMQ error");
    expect(reclaimResult.rows[0].claimed_at).toBeNull();

    const reclaimed = await claimPendingOutboxEvents(pool, 10);
    expect(reclaimed).toHaveLength(1);
  });
});

describe("concurrent dispatcher claiming", () => {
  it("two concurrent claim calls never return overlapping rows", async () => {
    for (let i = 0; i < 4; i++) {
      await insertJobAndOutbox();
    }

    const [claimA, claimB] = await Promise.all([
      claimPendingOutboxEvents(pool, 2),
      claimPendingOutboxEvents(pool, 2),
    ]);

    const idsA = claimA.map((e) => e.id);
    const idsB = claimB.map((e) => e.id);
    const overlap = idsA.filter((id) => idsB.includes(id));

    expect(overlap).toHaveLength(0);
    expect(idsA.length + idsB.length).toBeLessThanOrEqual(4);
    expect(idsA.length + idsB.length).toBeGreaterThan(0);
  });
});