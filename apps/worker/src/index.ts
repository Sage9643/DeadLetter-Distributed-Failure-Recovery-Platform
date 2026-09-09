import { env } from "./config/env";
import { startConsumer } from "./consumer";

console.log("Environment loaded:", { NODE_ENV: env.NODE_ENV });

startConsumer().catch((err) => {
  console.error("Worker failed to start:", err);
  process.exit(1);
});