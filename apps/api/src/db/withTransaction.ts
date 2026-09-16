import { PoolClient } from "pg";
import { pool } from "./pool";

// Generic transaction wrapper: BEGIN, run callback with a dedicated
// client, COMMIT on success, ROLLBACK on any thrown error. Callers MUST
// use the client passed into the callback for every statement that
// needs to be part of the transaction -- querying the shared pool
// directly inside the callback would run outside this transaction.
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}