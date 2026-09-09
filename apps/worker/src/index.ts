import { env } from "./config/env";
import { startConsumer } from "./consumer";
import { logger } from "./logger";

logger.info({ NODE_ENV: env.NODE_ENV }, "Environment loaded");

startConsumer().catch((err) => {
  logger.error({ err }, "Worker failed to start");
  process.exit(1);
});