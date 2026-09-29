import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  RABBITMQ_URL: z.string().min(1, "RABBITMQ_URL is required"),
  // TEST-ONLY: artificial delay (ms) inserted in the replay route handler,
  // after receiving the request but before the atomic replay claim.
  // Used to reliably widen the race window for the concurrent-replay
  // test. Defaults to 0 (disabled). See docs/failure-handling.md, Phase 6.
  REPLAY_TEST_DELAY_MS: z.coerce.number().int().min(0).default(0),
  // Phase 12: rate limiting. Token-bucket capacity (max burst size) and
  // window in seconds over which that capacity fully refills. Default
  // policy is 100 requests / 60 seconds per client. These are initial
  // development defaults, NOT experimentally-proven production capacity
  // numbers -- see docs/engineering-decisions.md.
  RATE_LIMIT_CAPACITY: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  // Phase 12: backpressure. Reject POST /api/jobs when pendingOutboxEvents
  // (fresh getStats() call, no caching) exceeds this threshold.
  BACKPRESSURE_THRESHOLD: z.coerce.number().int().positive().default(50),
  // Phase 16: public security baseline. A single shared API key,
  // required on state-changing routes only (POST /api/jobs,
  // POST /api/jobs/:id/replay -- see middleware/auth.ts and
  // routes/jobs.ts). GET routes remain unauthenticated -- deliberately
  // kept simple (a shared secret, not a full identity/session
  // platform), consistent with this project's stated anti-
  // overengineering scope. Optional in the schema itself so
  // development/test can run without setting it; enforced as REQUIRED
  // in production by the refinement below, so a production deployment
  // with this unset fails to start rather than silently running with
  // every mutating route open to anyone.
  API_KEY: z.string().min(1).optional(),
  // Phase 16: CORS. Comma-separated list of allowed origins for the
  // dashboard's cross-origin requests once it is served from a
  // different origin than the API (its own CDN/static host) rather
  // than through the Vite dev proxy. No wildcard is ever used for
  // authenticated behavior -- see app.ts. Optional so local dev
  // (same-origin via the Vite proxy) needs no configuration; required
  // in production by the refinement below.
  CORS_ALLOWED_ORIGINS: z.string().min(1).optional(),
  // Phase 16: explicit, documented request body size limit for
  // express.json(). Express's own undocumented-in-this-codebase
  // default is already 100kb; this makes that limit explicit,
  // deliberate, and configurable rather than an implicit library
  // default nobody chose.
  JSON_BODY_LIMIT: z.string().min(1).default("100kb"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.format());
  process.exit(1);
}

// Phase 16: production fails safe. A production deployment is refused
// at startup -- not silently allowed to run open -- if either the
// shared API key or the CORS allowlist is missing, since both are
// required for the public-security-baseline guarantees this project
// now makes. This mirrors the existing safeParse-then-exit pattern
// above rather than inventing a second validation mechanism.
if (parsed.data.NODE_ENV === "production") {
  const missing: string[] = [];
  if (!parsed.data.API_KEY) missing.push("API_KEY");
  if (!parsed.data.CORS_ALLOWED_ORIGINS) missing.push("CORS_ALLOWED_ORIGINS");
  if (missing.length > 0) {
    console.error(
      `Refusing to start in production without required secrets/config: ${missing.join(", ")}`
    );
    process.exit(1);
  }
}

export const env = parsed.data;