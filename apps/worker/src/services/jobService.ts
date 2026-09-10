import { pool } from "../db/pool";
import { STALE_PROCESSING_THRESHOLD_SECONDS } from "../retry/claimPolicy";

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

export async function getJobById(id: string): Promise<Job | null> {
  const result = await pool.query<Job>(`SELECT * FROM jobs WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

// Phase 5: Atomic conditional claim (WHERE clause and locking semantics
// UNCHANGED from Phase 5 -- see engineering-decisions.md). Phase 6 adds
// total_attempt_count as a second increment in the SAME atomic UPDATE,
// purely for lifetime observability; this does not alter the claim's
// correctness guarantee in any way.
export async function claimJob(id: string): Promise<Job | null> {
  const result = await pool.query<Job>(
    `UPDATE jobs
     SET status = 'PROCESSING',
         attempt_count = attempt_count + 1,
         total_attempt_count = total_attempt_count + 1,
         updated_at = now()
     WHERE id = $1
       AND (
         status IN ('QUEUED', 'RETRYING')
         OR (status = 'PROCESSING' AND updated_at < now() - ($2 * interval '1 second'))
       )
     RETURNING *`,
    [id, STALE_PROCESSING_THRESHOLD_SECONDS]
  );
  return result.rows[0] ?? null;
}

export async function markCompleted(id: string): Promise<Job> {
  const result = await pool.query<Job>(
    `UPDATE jobs
     SET status = 'COMPLETED',
         last_error = NULL,
         updated_at = now()
     WHERE id = $1
       AND status = 'PROCESSING'
     RETURNING *`,
    [id]
  );
  const job = result.rows[0];
  if (!job) throw new Error(`markCompleted: job ${id} not found or not in PROCESSING state`);
  return job;
}

// Retained from Phase 3/4 for backward compatibility. Not called by the
// consumer.
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
       AND status = 'PROCESSING'
     RETURNING *`,
    [id, errorMessage]
  );
  const job = result.rows[0];
  if (!job) throw new Error(`markRetrying: job ${id} not found or not in PROCESSING state`);
  return job;
}

// Phase 6: also records last_dead_lettered_at/last_dead_letter_reason.
// These are set here and NEVER cleared elsewhere (not by replay, not by
// a subsequent successful completion) -- preserving the fact that this
// job previously reached DEAD_LETTERED, per the project's requirement
// not to erase failure history.
export async function markDeadLettered(id: string, errorMessage: string): Promise<Job> {
  const result = await pool.query<Job>(
    `UPDATE jobs
     SET status = 'DEAD_LETTERED',
         last_error = $2,
         last_dead_lettered_at = now(),
         last_dead_letter_reason = $2,
         updated_at = now()
     WHERE id = $1
       AND status = 'PROCESSING'
     RETURNING *`,
    [id, errorMessage]
  );
  const job = result.rows[0];
  if (!job) throw new Error(`markDeadLettered: job ${id} not found or not in PROCESSING state`);
  return job;
}