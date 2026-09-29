import type { Request, Response, NextFunction, RequestHandler } from "express";
import { env } from "../config/env";

// Phase 16: public security baseline -- authentication for
// state-changing routes. Deliberately the simplest mechanism that is
// actually secure for this project's scope: a single shared API key,
// compared against the "x-api-key" request header. Not a session
// system, not JWT, not a user/identity platform -- this project has no
// concept of separate users or roles, only "trusted operator" vs.
// "anonymous public", so a shared secret is the right-sized tool, not
// an under-engineered shortcut.
//
// Applied ONLY to state-changing routes (POST /api/jobs,
// POST /api/jobs/:id/replay -- see routes/jobs.ts). GET routes stay
// public and unauthenticated on purpose: this is a demo/portfolio
// system meant to be publicly VIEWABLE (the dashboard, job history,
// stats), and gating read access behind the same secret used for
// mutations would also force that secret into the browser bundle to
// render the dashboard at all -- which Phase 16's rules explicitly
// forbid ("no secrets in frontend bundles"). Keeping reads open and
// gating only mutations is what makes that separation possible.
//
// Dev/test behavior: if env.API_KEY is unset, this middleware is a
// deliberate no-op (every request passes) -- env.ts's production
// refinement makes API_KEY REQUIRED once NODE_ENV=production, so this
// permissive fallback only ever applies to local development/test,
// exactly the same "gated by environment, not by pretending to be
// secure" pattern already used by rateLimiter.ts's
// TEST_CLIENT_ID_HEADER.
export const API_KEY_HEADER = "x-api-key";

export const requireApiKey: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
  if (!env.API_KEY) {
    // No key configured -- only reachable outside production (see
    // env.ts). Logged once per request at debug level so this
    // permissive dev/test state is visible in logs, never silent.
    req.log?.debug("requireApiKey: no API_KEY configured, allowing request (non-production only)");
    next();
    return;
  }

  const provided = req.header(API_KEY_HEADER);

  // Never log the provided or expected key value itself -- only
  // whether the check passed, per Phase 16's logging requirement that
  // secrets/tokens are never logged.
  if (provided && provided === env.API_KEY) {
    next();
    return;
  }

  req.log?.warn({ hasHeader: Boolean(provided) }, "Unauthorized: missing or invalid API key");
  res.status(401).json({ error: "Unauthorized", reason: "missing_or_invalid_api_key" });
};
