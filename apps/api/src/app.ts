import express from "express";
import pinoHttp from "pino-http";
import cors from "cors";
import compression from "compression";
import { jobsRouter } from "./routes/jobs";
import { healthRouter } from "./routes/health";
import { statsRouter } from "./routes/stats";
import { env } from "./config/env";
import { logger } from "./logger";

export const app = express();

app.use(pinoHttp());

// Phase 16: gzip/deflate response compression. JSON API responses
// compress well and this API has no large binary payloads to worry
// about excluding. Placed early so every response downstream
// (including error responses) is covered.
app.use(compression());

// Phase 16: explicit CORS allowlist. env.CORS_ALLOWED_ORIGINS is a
// comma-separated list of exact origins (e.g. the dashboard's real
// production origin); NEVER "*" for this app, since routes/jobs.ts's
// mutating endpoints require the "x-api-key" header, and allowing
// credentials/custom-header requests from an unlisted origin would
// undermine that boundary. With no origins configured (local dev,
// where the Vite dev server proxies /api same-origin -- see
// apps/dashboard/vite.config.ts), CORS simply is not needed and this
// falls back to same-origin-only behavior (no Access-Control-Allow-
// Origin header is set for any origin).
const allowedOrigins = env.CORS_ALLOWED_ORIGINS
  ? env.CORS_ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean)
  : [];

app.use(
  cors({
    origin(requestOrigin, callback) {
      // No Origin header (server-to-server, curl, same-origin) -- allow.
      if (!requestOrigin) {
        callback(null, true);
        return;
      }
      if (allowedOrigins.includes(requestOrigin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "x-api-key"],
  })
);

// Phase 16: explicit, configurable request body size limit (see
// config/env.ts -- JSON_BODY_LIMIT, defaults to Express's own
// historical default of "100kb", now an explicit, documented choice
// rather than an implicit library default nobody chose).
app.use(express.json({ limit: env.JSON_BODY_LIMIT }));

app.use("/api/health", healthRouter);
app.use("/api/jobs", jobsRouter);
app.use("/api/stats", statsRouter);

// Phase 16: centralized error handler. Must be registered LAST (after
// every route) -- Express only routes to a 4-arg middleware function
// as an error handler. Catches anything a route handler throws or
// rejects with (including Express 5's automatic catching of rejected
// async handlers) that no route-level try/catch already handled.
// Production responses never include a stack trace, SQL detail, or
// internal path -- only a generic message. The full error, including
// stack, is always logged server-side via the structured logger, so
// nothing is lost for debugging, only kept out of the HTTP response.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const log = req.log ?? logger;
  log.error({ err }, "Unhandled error in request handler");

  if (res.headersSent) {
    return;
  }

  const isProduction = env.NODE_ENV === "production";
  res.status(500).json({
    error: "Internal server error",
    ...(isProduction ? {} : { detail: err instanceof Error ? err.message : String(err) }),
  });
});
