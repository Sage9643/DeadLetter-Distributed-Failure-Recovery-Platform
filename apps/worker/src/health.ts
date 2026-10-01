import { createServer, type Server } from "http";
import { env } from "./config/env";
import { logger } from "./logger";

// Render Free Web Service compatibility ONLY. Render's free tier has
// no "background worker" service type -- only services that behave
// like an HTTP server are accepted. This server exists solely so
// Render has something to route its own health probe to and keep the
// container running; it is NOT a public API, has no routes, and never
// touches RabbitMQ, PostgreSQL, job claiming, retries, or DLX/DLQ in
// any way -- all of that remains exactly as implemented in
// consumer.ts, unchanged by this file.
//
// Responds 200 to any request. There is nothing meaningful to report
// here beyond "the process is alive and the event loop is running" --
// real health (is the RabbitMQ consumer actually attached and
// processing?) is still observed the way it always has been: through
// structured logs and the real chaos/verification evidence described
// in docs/deployment.md and docs/incidents-and-failures.md, never a
// fabricated readiness signal invented for this endpoint.
export function startHealthServer(): Server {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  });

  server.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT },
      "Worker health server listening (Render compatibility only -- not a public API)"
    );
  });

  return server;
}
