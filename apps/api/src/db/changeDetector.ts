import { Pool } from "pg";

export interface JobChange {
  id: string;
  status: string;
  updated_at: string;
}

// Pure query function: returns jobs updated strictly after `since`.
// No timers, no internal state -- fully deterministic and testable
// against a real Postgres connection by inserting/updating rows and
// calling this directly with a controlled `since` value.
export async function getJobChangesSince(pool: Pool, since: Date): Promise<JobChange[]> {
  const result = await pool.query<JobChange>(
    `SELECT id, status, updated_at FROM jobs WHERE updated_at > $1 ORDER BY updated_at ASC`,
    [since]
  );
  return result.rows;
}

// Establishes a startup cursor using PostgreSQL's OWN clock (not the
// Node process's Date.now()), executed as the very first action before
// polling begins. This avoids both failure modes: (a) broadcasting the
// entire historical jobs table on boot (anything before this instant is
// never picked up, since all queries use "updated_at > cursor"), and
// (b) missing an update that occurs during startup (anything after this
// instant is guaranteed to be caught on the very first poll tick,
// because there is no separate "initialization window" -- the cursor
// IS the first thing established, atomically, in one query). See
// docs/engineering-decisions.md for the full rationale and the one
// accepted, documented edge case (same-microsecond collision).
export async function getStartupCursor(pool: Pool): Promise<Date> {
  const result = await pool.query<{ now: string }>(`SELECT now() as now`);
  const row = result.rows[0];
  if (!row) {
    throw new Error("getStartupCursor: no row returned from SELECT now()");
  }
  return new Date(row.now);
}