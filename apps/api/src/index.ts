import { env } from "./config/env";
import { pool } from "./db/pool";
import { createJob, getJobById } from "./services/jobService";

async function main() {
  console.log("Environment loaded:", { NODE_ENV: env.NODE_ENV, PORT: env.PORT });

  const created = await createJob({ type: "send_email", payload: { to: "test@example.com" } });
  console.log("Job created:", created);

  const fetched = await getJobById(created.id);
  console.log("Job fetched by id:", fetched);

  await pool.end();
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});