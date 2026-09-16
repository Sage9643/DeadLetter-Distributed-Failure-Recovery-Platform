import http from "http";
import { WebSocketServer } from "ws";
import { env } from "./config/env";
import { app } from "./app";
import { pool } from "./db/pool";
import { logger } from "./logger";
import { Broadcaster } from "./ws/broadcaster";
import { startChangePoller, ChangePollerHandle } from "./ws/changePoller";
import { startOutboxDispatcher, DispatcherHandle } from "./outbox/dispatcher";

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: "/ws" });
const broadcaster = new Broadcaster(wss);

wss.on("connection", (ws) => {
  logger.info({ clients: wss.clients.size }, "Dashboard WebSocket client connected");
  ws.on("close", () => {
    logger.info({ clients: wss.clients.size }, "Dashboard WebSocket client disconnected");
  });
});

let pollerHandle: ChangePollerHandle | null = null;
let outboxDispatcherHandle: DispatcherHandle | null = null;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "API shutting down");
  pollerHandle?.stop();
  outboxDispatcherHandle?.stop();
  wss.close();
  server.close();
  try {
    await pool.end();
    logger.info("PostgreSQL pool closed cleanly");
  } catch (err) {
    logger.error({ err }, "Error while closing PostgreSQL pool during shutdown");
  }
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "DeadLetter API listening");
});

startChangePoller(pool, broadcaster)
  .then((handle) => {
    pollerHandle = handle;
  })
  .catch((err) => {
    logger.error({ err }, "Failed to start change poller");
  });

outboxDispatcherHandle = startOutboxDispatcher(pool);