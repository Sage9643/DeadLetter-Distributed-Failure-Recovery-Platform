import { pool } from "../db/pool";

export interface Job {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: string;
  attempt_count: number;
  max_attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export async function getJobById(id: string): Promise<Job | null> {
  const result = await pool.query<Job>(`SELECT * FROM jobs WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function markProcessing(id: string): Promise<Job> {
  const result = await pool.query<Job>(
    `UPDATE jobs
     SET status = 'PROCESSING',
         attempt_count = attempt_count + 1,
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id]
  );
  const job = result.rows[0];
  if (!job) throw new Error(`markProcessing: job ${id} not found`);
  return job;
}

export async function markCompleted(id: string): Promise<Job> {
  const result = await pool.query<Job>(
    `UPDATE jobs
     SET status = 'COMPLETED',
         last_error = NULL,
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id]
  );
  const job = result.rows[0];
  if (!job) throw new Error(`markCompleted: job ${id} not found`);
  return job;
}

// Retained from Phase 3 for backward compatibility / potential direct use.
// As of Phase 4 the consumer no longer calls this — failures now resolve
// to either markRetrying or markDeadLettered. See engineering-decisions.md.
export async function markFailed(id: string, errorMessage: string): Promise<Job> {
  const result = await pool.query<Job>(
    `UPDATE jobs
     SET status = 'FAILED',
         last_error = $2,
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, errorMessage]
  );
  const job = result.rows[0];
  if (!job) throw new Error(`markFailed: job ${id} not found`);
  return job;
}

export async function markRetrying(id: string, errorMessage: string): Promise<Job> {
  const result = await pool.query<Job>(
    `UPDATE jobs
     SET status = 'RETRYING',
         last_error = $2,
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, errorMessage]
  );
  const job = result.rows[0];
  if (!job) throw new Error(`markRetrying: job ${id} not found`);
  return job;
}

export async function markDeadLettered(id: string, errorMessage: string): Promise<Job> {
  const result = await pool.query<Job>(
    `UPDATE jobs
     SET status = 'DEAD_LETTERED',
         last_error = $2,
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, errorMessage]
  );
  const job = result.rows[0];
  if (!job) throw new Error(`markDeadLettered: job ${id} not found`);
  return job;
}