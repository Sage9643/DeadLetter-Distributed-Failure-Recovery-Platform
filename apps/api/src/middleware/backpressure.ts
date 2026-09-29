import type { Request, Response, NextFunction, RequestHandler } from "express";
import { getStats } from "../services/statsService";
import { env } from "../config/env";

// Phase 12: DeadLetter-specific backpressure. Unlike rateLimiter.ts, this
// file deliberately DOES know about DeadLetter concepts (pendingOutboxEvents
// from statsService) -- the design review distinguishes the two: rate
// limiting is a generic, reusable protection; backpressure is a signal
// specific to THIS system's actual health.
//
// Applied ONLY to POST /api/jobs (see routes/jobs.ts). Explicitly NOT
// applied to POST /api/jobs/:id/replay -- see engineering-decisions.md
// for why: replay is how an operator drains an existing backlog (moving
// DEAD_LETTERED jobs back to QUEUED), and it does not create a NEW outbox
// event any differently than createJob does structurally, but gating the
// one operation that recovers from backlog BEHIND that same backlog
// would be self-defeating.
//
// getStats() is called fresh on every single request -- no caching layer,
// per the locked design ("Do NOT cache pendingOutboxEvents"). The
// alternative (a periodically-refreshed cached value) was rejected
// because it would let the API keep admitting jobs for up to a whole
// cache-refresh interval after the real backlog crossed the threshold,
// which defeats the purpose of a backpressure signal meant to be
// authoritative right now, not "as of N seconds ago". The cost of this
// choice is one extra aggregate SQL query per POST /api/jobs request --
// see docs/observability.md for the measured cost of that query.

export interface BackpressureOptions {
  /**
   * Pending-outbox-event threshold above which requests are rejected.
   * Defaults to env.BACKPRESSURE_THRESHOLD. Tests override this with a
   * small deterministic value instead of needing to insert 51+ real
   * outbox rows to exercise the rejection path.
   */
  threshold?: number;
}

export function createBackpressureMiddleware(options: BackpressureOptions = {}): RequestHandler {
  const threshold = options.threshold ?? env.BACKPRESSURE_THRESHOLD;

  return async function backpressure(req: Request, res: Response, next: NextFunction): Promise<void> {
    const stats = await getStats();

    if (stats.pendingOutboxEvents > threshold) {
      req.log?.warn(
        { pendingOutboxEvents: stats.pendingOutboxEvents, threshold },
        "Backpressure threshold exceeded; rejecting POST /api/jobs"
      );
      res.setHeader("Retry-After", "5");
      res.status(503).json({
        error: "Service temporarily unable to accept new jobs",
        reason: "backpressure",
        pendingOutboxEvents: stats.pendingOutboxEvents,
      });
      return;
    }

    next();
  };
}

// Production instance, wired into routes/jobs.ts. Uses env.BACKPRESSURE_THRESHOLD.
export const backpressure = createBackpressureMiddleware();
