import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  RABBITMQ_URL: z.string().min(1, "RABBITMQ_URL is required"),
  // TEST-ONLY: absolute Unix epoch (ms). If set, the worker sleeps until
  // this exact wall-clock moment before every claim attempt, instead of
  // a fixed relative delay -- this is what allows two independent worker
  // processes to genuinely converge their claim attempts to the same
  // instant, regardless of when each received its message. Defaults to
  // 0 (disabled). See docs/failure-handling.md, Phase 5.
  CLAIM_TEST_SYNC_EPOCH_MS: z.coerce.number().int().min(0).default(0),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;