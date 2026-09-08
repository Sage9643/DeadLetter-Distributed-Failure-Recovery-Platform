import { env } from "./config/env";
import { pool } from "./db/pool";

async function main() {
  console.log("Environment loaded:", { NODE_ENV: env.NODE_ENV, PORT: env.PORT });

  const result = await pool.query("SELECT NOW() as current_time");
  console.log("Database connection successful:", result.rows[0]);

  await pool.end();
}

main().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});