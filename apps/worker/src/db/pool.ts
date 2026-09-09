import { Pool } from "pg";
import { env } from "../config/env";
import { logger } from "../logger";

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
});

pool.on("error", (err) => {
  logger.error({ err }, "Unexpected PostgreSQL pool error");
  process.exit(1);
});