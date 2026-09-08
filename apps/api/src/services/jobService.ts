import { pool } from "../db/pool";
import { CreateJobInput } from "../validation/jobSchema";

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

export async function createJob(input: CreateJobInput): Promise<Job> {
  const result = await pool.query<Job>(
    `INSERT INTO jobs (type, payload)
     VALUES ($1, $2)
     RETURNING *`,
    [input.type, input.payload]
  );

  const job = result.rows[0];
  if (!job) {
    throw new Error("Failed to create job: no row returned from INSERT");
  }

  return job;
}

export async function getJobById(id: string): Promise<Job | null> {
  const result = await pool.query<Job>(
    `SELECT * FROM jobs WHERE id = $1`,
    [id]
  );

  return result.rows[0] ?? null;
}