import { pool } from "../../db/pool";

export { pool };

export async function assertTestDatabase(): Promise<void> {
  const result = await pool.query<{ current_database: string }>(
    "SELECT current_database()"
  );
  const dbName = result.rows[0]?.current_database;
  if (dbName !== "deadletter_test") {
    throw new Error(
      `SAFETY ABORT: connected database is "${dbName}", expected ` +
      `"deadletter_test". Refusing to run destructive test setup. ` +
      `Check DATABASE_URL / .env.test.`
    );
  }
}

export async function truncateJobs(): Promise<void> {
  await assertTestDatabase();
  // Phase 10: CASCADE required now that outbox_events has a FK to
  // jobs(id). This also means any future table referencing jobs is
  // automatically truncated here too, with no further edit needed.
  await pool.query("TRUNCATE TABLE jobs CASCADE;");
}