import { pool } from "../db/pool";

export interface JobStats {
  totalJobs: number;
  byStatus: Record<string, number>;
  totalReplays: number;
  totalAttempts: number;
}

// Single aggregate query, one round trip. Postgres COUNT/SUM return
// bigint, which the pg driver returns as string -- explicitly converted
// with Number() below. FILTER clauses cover all 6 CHECK-constraint
// status values, including FAILED: no worker code has written FAILED
// since Phase 4 (superseded by RETRYING/DEAD_LETTERED), but real
// historical rows from Phases 3 still exist and a stats endpoint that
// silently dropped them would misrepresent total job counts.
export async function getStats(): Promise<JobStats> {
  const result = await pool.query<{
    total_jobs: string;
    queued: string;
    processing: string;
    completed: string;
    failed: string;
    retrying: string;
    dead_lettered: string;
    total_replays: string;
    total_attempts: string;
  }>(
    `SELECT
       COUNT(*) AS total_jobs,
       COUNT(*) FILTER (WHERE status = 'QUEUED') AS queued,
       COUNT(*) FILTER (WHERE status = 'PROCESSING') AS processing,
       COUNT(*) FILTER (WHERE status = 'COMPLETED') AS completed,
       COUNT(*) FILTER (WHERE status = 'FAILED') AS failed,
       COUNT(*) FILTER (WHERE status = 'RETRYING') AS retrying,
       COUNT(*) FILTER (WHERE status = 'DEAD_LETTERED') AS dead_lettered,
       COALESCE(SUM(replay_count), 0) AS total_replays,
       COALESCE(SUM(total_attempt_count), 0) AS total_attempts
     FROM jobs`
  );

  const row = result.rows[0];
  if (!row) {
    // Defensive only: aggregate queries with no GROUP BY always return
    // exactly one row, even against an empty table.
    throw new Error("getStats: no row returned from aggregate query");
  }

  return {
    totalJobs: Number(row.total_jobs),
    byStatus: {
      QUEUED: Number(row.queued),
      PROCESSING: Number(row.processing),
      COMPLETED: Number(row.completed),
      FAILED: Number(row.failed),
      RETRYING: Number(row.retrying),
      DEAD_LETTERED: Number(row.dead_lettered),
    },
    totalReplays: Number(row.total_replays),
    totalAttempts: Number(row.total_attempts),
  };
}