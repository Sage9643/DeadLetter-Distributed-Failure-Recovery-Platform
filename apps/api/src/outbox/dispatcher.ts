import { Pool } from "pg";
import { claimPendingOutboxEvents, markOutboxPublished, markOutboxFailed } from "./outboxService";
import { publishJobCreated } from "../queue/publisher";
import { logger } from "../logger";

const POLL_INTERVAL_MS = 2000;
const BATCH_SIZE = 10;

export interface DispatcherHandle {
  stop: () => void;
}

// Publishes claimed outbox events to RabbitMQ, reusing the EXISTING,
// UNCHANGED publishJobCreated (Phase 2) -- the outbox does not
// introduce a second publish path or a modified message format. The
// RabbitMQ publish deliberately happens OUTSIDE any open PostgreSQL
// transaction (the claim already committed before this runs), so a
// slow or failing RabbitMQ call never holds a DB transaction/lock open.
//
// IMPORTANT -- explicitly NOT exactly-once: if publishJobCreated
// succeeds but this process crashes before markOutboxPublished commits,
// the row remains claimed, is later reclaimed as stale, and WILL be
// published again on a subsequent attempt. This is real and accepted.
// Duplicate delivery is handled entirely by the worker's existing
// atomic claimJob (Phase 5), unchanged and untouched by this phase.
export async function dispatchOutboxBatch(pool: Pool): Promise<{ attempted: number; published: number; failed: number }> {
  const claimed = await claimPendingOutboxEvents(pool, BATCH_SIZE);
  let published = 0;
  let failed = 0;

  for (const event of claimed) {
    try {
      await publishJobCreated(event.job_id);
      await markOutboxPublished(pool, event.id);
      published += 1;
    }catch (err) {
      // AggregateError (e.g. Node's net module when a connection fails
      // over both IPv6/IPv4) has an empty top-level .message by design
      // -- the real detail lives in .errors (or the older
      // .aggregateErrors seen on some Node error-serialization paths).
      // Prefer that nested detail when present so last_error is
      // actually diagnostic, rather than silently recording "".
      let message: string;
      if (err instanceof AggregateError && err.errors.length > 0) {
        message = err.errors.map((e) => (e instanceof Error ? e.message : String(e))).join("; ");
      } else if (err instanceof Error) {
        message = err.message || err.name || String(err);
      } else {
        message = String(err);
      }
      await markOutboxFailed(pool, event.id, message);
      failed += 1;
      logger.error({ err, outboxId: event.id, jobId: event.job_id }, "Outbox dispatch failed; will retry");
    }
  }

  return { attempted: claimed.length, published, failed };
}

export function startOutboxDispatcher(pool: Pool): DispatcherHandle {
  const intervalId = setInterval(() => {
    dispatchOutboxBatch(pool).catch((err) => {
      logger.error({ err }, "Outbox dispatcher tick failed");
    });
  }, POLL_INTERVAL_MS);

  return {
    stop: () => clearInterval(intervalId),
  };
}