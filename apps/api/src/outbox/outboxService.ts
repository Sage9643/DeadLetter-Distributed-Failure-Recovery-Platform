import { Pool, PoolClient } from "pg";

export interface OutboxEvent {
  id: string;
  job_id: string;
  created_at: string;
  claimed_at: string | null;
  published_at: string | null;
  attempts: number;
  last_error: string | null;
}

// A claimed row not marked published/failed within this window is
// treated as orphaned (dispatcher likely crashed) and becomes eligible
// for reclaim -- mirrors Phase 5's STALE_PROCESSING_THRESHOLD_SECONDS
// pattern exactly.
export const STALE_CLAIM_THRESHOLD_SECONDS = 30;

// Inserted as part of the SAME transaction as the job insert/update.
// Callers MUST pass the transaction's client (from withTransaction),
// not the shared pool -- otherwise this insert would not be atomic
// with the job change it accompanies, defeating the entire purpose.
export async function insertOutboxEvent(client: PoolClient, jobId: string): Promise<void> {
  await client.query(`INSERT INTO outbox_events (job_id) VALUES ($1)`, [jobId]);
}

// Atomic conditional claim: a single UPDATE with SKIP LOCKED, so
// concurrent dispatcher instances can never claim the same row (proven
// in outboxService.test.ts via real concurrent Promise.all execution,
// same evidentiary standard as Phase 5/6's claimJob/claimReplay
// concurrency tests). Also reclaims rows whose claimed_at is stale --
// a prior claim that never completed (e.g. dispatcher crash) --
// mirroring Phase 5's stale-PROCESSING reclaim design.
export async function claimPendingOutboxEvents(pool: Pool, batchSize: number): Promise<OutboxEvent[]> {
  const result = await pool.query<OutboxEvent>(
    `UPDATE outbox_events
     SET claimed_at = now()
     WHERE id IN (
       SELECT id FROM outbox_events
       WHERE published_at IS NULL
         AND (claimed_at IS NULL OR claimed_at < now() - ($2 * interval '1 second'))
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [batchSize, STALE_CLAIM_THRESHOLD_SECONDS]
  );
  return result.rows;
}

export async function markOutboxPublished(pool: Pool, id: string): Promise<void> {
  await pool.query(`UPDATE outbox_events SET published_at = now() WHERE id = $1`, [id]);
}

// On failure, claimed_at resets to NULL so the row is immediately
// eligible for the NEXT dispatcher tick, rather than waiting the full
// staleness window -- a genuine publish failure should be retried
// promptly, not only after a crash-recovery timeout.
export async function markOutboxFailed(pool: Pool, id: string, errorMessage: string): Promise<void> {
  await pool.query(
    `UPDATE outbox_events
     SET claimed_at = NULL, attempts = attempts + 1, last_error = $2
     WHERE id = $1`,
    [id, errorMessage]
  );
}

export async function countPendingOutboxEvents(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM outbox_events WHERE published_at IS NULL`
  );
  return Number(result.rows[0]?.count ?? 0);
}