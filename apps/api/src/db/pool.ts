import { Pool } from "pg";
import { env } from "../config/env";

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
});

pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error:", err);
  process.exit(1);
});