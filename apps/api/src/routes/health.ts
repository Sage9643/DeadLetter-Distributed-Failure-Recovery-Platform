import { Router } from "express";
import { pool } from "../db/pool";
import { checkRabbitMQHealth } from "../queue/connection";

export const healthRouter = Router();

// Liveness: is the process itself running and able to respond?
// Behavior preserved byte-identical to the original inline handler
// that lived in app.ts.
healthRouter.get("/", (req, res) => {
  req.log.info("Health check requested");
  res.json({ status: "ok" });
});

// Readiness: are this API's actual dependencies currently reachable?
// Distinct from liveness -- the process can be "alive" while a
// dependency is unusable, exactly as demonstrated by Incident 5
// (Phase 6): a dead RabbitMQ channel after a broker restart, invisible
// to liveness alone. This does not fix Incident 5's underlying
// reconnection gap -- it honestly reports the currently-broken state
// instead of staying silent about it.
healthRouter.get("/ready", async (req, res) => {
  const [postgresResult, rabbitmqResult] = await Promise.allSettled([
    pool.query("SELECT 1"),
    checkRabbitMQHealth(),
  ]);

  const postgresOk = postgresResult.status === "fulfilled";
  const rabbitmqOk = rabbitmqResult.status === "fulfilled";

  const body = {
    postgres: postgresOk ? "ok" : "error",
    rabbitmq: rabbitmqOk ? "ok" : "error",
  };

  if (postgresOk && rabbitmqOk) {
    req.log.info(body, "Readiness check passed");
    res.status(200).json(body);
  } else {
    req.log.warn(body, "Readiness check failed");
    res.status(503).json(body);
  }
});