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
  await pool.query("TRUNCATE TABLE jobs;");
}