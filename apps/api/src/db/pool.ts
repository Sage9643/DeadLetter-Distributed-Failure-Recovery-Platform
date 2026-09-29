import { Pool } from "pg";
import { env } from "../config/env";
import { logger } from "../logger";

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
});

// Phase 15: a pool-level "error" event fires for an already-connected,
// currently-IDLE client that hits a background/network-level failure
// (e.g. Postgres restarting, a network blip) -- it does NOT mean every
// connection is down and it is not the same thing as a query rejecting
// in the foreground (those are already handled at each call site: see
// routes/health.ts's Promise.allSettled). node-postgres's Pool already
// discards the errored client internally and will lazily create a
// fresh connection the next time one is needed -- nothing needs to be
// torn down for the pool to keep working. Previously this handler
// called process.exit(1), which killed the entire API process on any
// such event; in this project's real deployment (infra/docker-compose.yml
// only runs postgres/rabbitmq -- API and worker run unsupervised via
// `npm run dev`, no restart policy), that meant a transient Postgres
// blip took the whole API down with nothing to bring it back. This log
// line replaces that crash -- see docs/incidents-and-failures.md and
// docs/engineering-decisions.md, Phase 15, for the full rationale and
// the deliberate scope boundary (this only changes the pool's
// background error handling; foreground query error handling at every
// existing call site is untouched).
pool.on("error", (err) => {
  logger.error({ err }, "PostgreSQL pool error (idle client); pool remains available, no process restart");
});
