import { publishJobCreated } from "../queue/publisher";
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
  total_attempt_count: number;
  replay_count: number;
  last_dead_lettered_at: string | null;
  last_dead_letter_reason: string | null;
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

  await publishJobCreated(job.id);

  return job;
}

export async function getJobById(id: string): Promise<Job | null> {
  const result = await pool.query<Job>(
    `SELECT * FROM jobs WHERE id = $1`,
    [id]
  );

  return result.rows[0] ?? null;
}

// Phase 6: Atomic conditional replay claim. Structurally identical to the
// worker's claimJob (Phase 5) -- a single UPDATE with the eligibility
// check in its WHERE clause, no preliminary SELECT. Two concurrent
// replay requests for the same job: Postgres row-level locking
// guarantees at most one can match WHERE status='DEAD_LETTERED' and
// receive a row; the other evaluates against the already-updated
// (now QUEUED) row and matches zero rows.
//
// attempt_count resets to 0 (fresh per-cycle retry budget -- see
// engineering-decisions.md for why preserving it instead would break
// Phase 4's exhaustion check). total_attempt_count is NOT touched here
// (it only increments on actual worker claims, in worker/jobService.ts).
// last_dead_lettered_at/last_dead_letter_reason are NOT touched --
// deliberately preserved indefinitely.
export async function claimReplay(id: string): Promise<Job | null> {
  const result = await pool.query<Job>(
    `UPDATE jobs
     SET status = 'QUEUED',
         attempt_count = 0,
         replay_count = replay_count + 1,
         last_error = NULL,
         updated_at = now()
     WHERE id = $1
       AND status = 'DEAD_LETTERED'
     RETURNING *`,
    [id]
  );
  return result.rows[0] ?? null;
}