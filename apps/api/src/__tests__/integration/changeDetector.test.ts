import { pool } from "../../db/pool";
import { truncateJobs } from "../helpers/testDb";
import { getJobChangesSince, getStartupCursor } from "../../db/changeDetector";

async function insertJob(status: string) {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO jobs (type, payload, status) VALUES ('test_job', '{}'::jsonb, $1) RETURNING id`,
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
});

describe("getStartupCursor", () => {
  it("does not pick up jobs that existed before the cursor was established (no historical broadcast on boot)", async () => {
    await insertJob("QUEUED");
    const cursor = await getStartupCursor(pool);
    const changes = await getJobChangesSince(pool, cursor);
    expect(changes).toHaveLength(0);
  });
});

describe("getJobChangesSince", () => {
  it("returns jobs updated after the given cursor, ordered ascending by updated_at", async () => {
    const cursor = await getStartupCursor(pool);

    const id1 = await insertJob("QUEUED");
    await pool.query("SELECT pg_sleep(0.01)");
    const id2 = await insertJob("QUEUED");

    const changes = await getJobChangesSince(pool, cursor);

    expect(changes.map((c) => c.id)).toEqual([id1, id2]);
  });

  it("does not return jobs updated before the cursor (no missed-update gap at startup)", async () => {
    const id1 = await insertJob("QUEUED");
    await pool.query("SELECT pg_sleep(0.01)");
    const cursor = await getStartupCursor(pool);

    const changes = await getJobChangesSince(pool, cursor);

    expect(changes.find((c) => c.id === id1)).toBeUndefined();
  });
});