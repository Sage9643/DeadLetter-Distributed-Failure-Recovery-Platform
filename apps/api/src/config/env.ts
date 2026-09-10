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
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;