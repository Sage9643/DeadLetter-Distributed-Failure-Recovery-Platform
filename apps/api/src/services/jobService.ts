import { pool } from "../db/pool";
import { CreateJobInput } from "../validation/jobSchema";
import { withTransaction } from "../db/withTransaction";
import { insertOutboxEvent } from "../outbox/outboxService";

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

// Phase 10: job insertion and its outbox event are now written in ONE
// PostgreSQL transaction. This closes the dual-write gap reproduced in
// Phase 2 (Deliberate Test 2) -- a job can no longer exist in Postgres
// without a durable record that a RabbitMQ message still needs to be
// published. The RabbitMQ publish itself no longer happens here at
// all; it is performed asynchronously by the outbox dispatcher (see
// apps/api/src/outbox/dispatcher.ts). See engineering-decisions.md --
// this does NOT provide exactly-once delivery.
export async function createJob(input: CreateJobInput): Promise<Job> {
  return withTransaction(async (client) => {
    const result = await client.query<Job>(
      `INSERT INTO jobs (type, payload)
       VALUES ($1, $2)
       RETURNING *`,
      [input.type, input.payload]
    );

    const job = result.rows[0];
    if (!job) {
      throw new Error("Failed to create job: no row returned from INSERT");
    }

    await insertOutboxEvent(client, job.id);

    return job;
  });
}

export async function getJobById(id: string): Promise<Job | null> {
  const result = await pool.query<Job>(
    `SELECT * FROM jobs WHERE id = $1`,
    [id]
  );

  return result.rows[0] ?? null;
}

export interface RecentJob {
  id: string;
  type: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  created_at: string;
  updated_at: string;
}

// Phase 9: fixed recent-activity list for the dashboard. LIMIT 20, no
// pagination (per approved design). Ordered by updated_at DESC --
// surfaces the most recently ACTIVE jobs (including retries/replays
// touching an old job), not merely the most recently created ones,
// which is more operationally useful for an "at a glance" view.
// Returns only the columns the dashboard's recent-jobs table actually
// needs, not every column (unlike getJobById, which intentionally
// returns everything for the detail view).
export async function listRecentJobs(): Promise<RecentJob[]> {
  const result = await pool.query<RecentJob>(
    `SELECT id, type, status, attempt_count, max_attempts, created_at, updated_at
     FROM jobs
     ORDER BY updated_at DESC
     LIMIT 20`
  );
  return result.rows;
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
//
// Phase 10: the conditional UPDATE and its outbox event insertion now
// happen in ONE transaction, closing the same dual-write gap reproduced
// in Phase 6 (Deliberate Test 3) for the replay path specifically. If
// the UPDATE matches zero rows (lost a race, already terminal, or not
// DEAD_LETTERED), NO outbox event is inserted -- claimReplay's exact
// existing conditional semantics are fully preserved.
export async function claimReplay(id: string): Promise<Job | null> {
  return withTransaction(async (client) => {
    const result = await client.query<Job>(
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

    const job = result.rows[0];
    if (!job) {
      return null;
    }

    await insertOutboxEvent(client, job.id);

    return job;
  });
}
