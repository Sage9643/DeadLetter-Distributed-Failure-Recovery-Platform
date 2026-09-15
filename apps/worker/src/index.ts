import { env } from "./config/env";
import { startConsumer } from "./consumer";
import { logger } from "./logger";
import { closeConnection } from "./queue/connection";

logger.info({ NODE_ENV: env.NODE_ENV }, "Environment loaded");

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Worker shutting down");
  try {
    await closeConnection();
    logger.info("RabbitMQ connection closed cleanly");
  } catch (err) {
    logger.error({ err }, "Error while closing RabbitMQ connection during shutdown");
  }
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

startConsumer().catch((err) => {
  logger.error({ err }, "Worker failed to start");
  process.exit(1);
});