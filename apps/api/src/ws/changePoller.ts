import { Pool } from "pg";
import { getJobChangesSince, getStartupCursor } from "../db/changeDetector";
import { Broadcaster, JobUpdatedEvent } from "./broadcaster";
import { logger } from "../logger";

const POLL_INTERVAL_MS = 2000;

export interface ChangePollerHandle {
  stop: () => void;
}

// Orchestrates: establish a safe startup cursor (getStartupCursor, using
// Postgres's own clock -- see changeDetector.ts), then on each tick
// query for jobs changed since the cursor, advance the cursor to the
// latest updated_at seen, and broadcast one job.updated event per
// changed row.
//
// Deliberately NOT unit tested with real timers -- getJobChangesSince
// and getStartupCursor are the deterministic, testable core (see
// apps/api/src/__tests__/integration/changeDetector.test.ts); this
// function is a thin, largely-untested scheduling wrapper around them,
// per the approved design correction.
export async function startChangePoller(pool: Pool, broadcaster: Broadcaster): Promise<ChangePollerHandle> {
  let cursor = await getStartupCursor(pool);
  logger.info({ cursor: cursor.toISOString() }, "Change poller started");

  const intervalId = setInterval(async () => {
    try {
      const changes = await getJobChangesSince(pool, cursor);
      for (const change of changes) {
        const event: JobUpdatedEvent = {
          type: "job.updated",
          jobId: change.id,
          status: change.status,
          updatedAt: change.updated_at,
        };
        broadcaster.broadcast(event);
      }
      const last = changes[changes.length - 1];
      if (last) {
        cursor = new Date(last.updated_at);
      }
    } catch (err) {
      logger.error({ err }, "Change poller tick failed");
    }
  }, POLL_INTERVAL_MS);

  return {
    stop: () => clearInterval(intervalId),
  };
}