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