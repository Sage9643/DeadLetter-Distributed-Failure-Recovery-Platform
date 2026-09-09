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
}

export async function getJobById(id: string): Promise<Job | null> {
  const result = await pool.query<Job>(`SELECT * FROM jobs WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

// Phase 5: Atomic conditional claim. This is the SOLE gatekeeper into
// processing -- the status check and the state transition happen in ONE
// SQL statement. Postgres row-level locking under READ COMMITTED (the
// default) guarantees that when two callers race to claim the same row,
// only one can successfully match the WHERE clause and receive a row;
// the other necessarily evaluates against the already-updated row and
// matches zero rows.
//
// The WHERE clause also allows reclaiming a job stuck in PROCESSING if
// its updated_at is older than STALE_PROCESSING_THRESHOLD_SECONDS --
// without this, a worker crash between claim and terminal write would
// permanently orphan the job, since ordinary redelivery would otherwise
// never match (status is PROCESSING, not QUEUED/RETRYING).
//
// Returns the claimed Job (attempt_count already incremented) if this
// call won the claim, or null if not claimable: already terminal,
// actively PROCESSING elsewhere (recent updated_at), does not exist, or
// this call lost a race against a concurrent claim attempt.
export async function claimJob(id: string): Promise<Job | null> {
  const result = await pool.query<Job>(
    `UPDATE jobs
     SET status = 'PROCESSING',
         attempt_count = attempt_count + 1,
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
  // Defense-in-depth only: the sole caller is the worker that just
  // atomically claimed this job via claimJob(), so status should
  // always be PROCESSING here. A throw here indicates an unexpected
  // code path, not a normal race outcome.
  if (!job) throw new Error(`markCompleted: job ${id} not found or not in PROCESSING state`);
  return job;
}

// Retained from Phase 3/4 for backward compatibility. Not called by the
// consumer (superseded by markRetrying/markDeadLettered).
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

export async function markDeadLettered(id: string, errorMessage: string): Promise<Job> {
  const result = await pool.query<Job>(
    `UPDATE jobs
     SET status = 'DEAD_LETTERED',
         last_error = $2,
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