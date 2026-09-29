import type { Request, Response, NextFunction, RequestHandler } from "express";

// Phase 12: generic, reusable in-memory per-client token-bucket rate
// limiter. Deliberately route-agnostic -- this file has no knowledge of
// jobs, replay, outbox, or any other DeadLetter-specific concept, so it
// could be lifted into an unrelated project unchanged. DeadLetter-specific
// wiring (which routes use it, what capacity) lives in routes/jobs.ts and
// config/env.ts, not here.
//
// Algorithm: classic token bucket. Each client key gets a bucket that
// starts full (capacity tokens) and refills continuously at
// capacity/windowSeconds tokens per second, capped at capacity. Each
// admitted request consumes exactly one token. This allows a client to
// burst up to `capacity` requests instantly, then sustains
// capacity/windowSeconds requests/sec indefinitely -- standard token-bucket
// behavior, not a fixed-window counter (which would allow a 2x burst at
// window boundaries).
//
// State is a plain in-memory Map, not Redis. See
// docs/engineering-decisions.md for why: this is a single-process API
// (Phase 0-11 never introduced horizontal scaling or a shared cache), and
// adding Redis here would be infrastructure for a scaling problem that
// does not exist yet. The explicit cost of this choice: state is lost on
// every API restart (all buckets reset to full), and if the API is ever
// run as more than one instance, each instance enforces its own
// independent limit with no cross-instance coordination. Both are
// documented limitations, not oversights.

export interface RateLimiterOptions {
  /** Maximum tokens a bucket can hold -- the burst size. */
  capacity: number;
  /** Seconds for a fully-drained bucket to refill to capacity. */
  windowSeconds: number;
  /**
   * How to derive the client identity key for a request. Defaults to
   * defaultIdentify (req.ip, with a NODE_ENV-gated test override -- see
   * below). Overridable per-instance so this middleware stays reusable
   * outside of any Express/req.ip-specific assumption if needed.
   */
  identify?: (req: Request) => string;
  /** Injectable clock, real Date.now() by default. Tests supply a fake. */
  now?: () => number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

// TEST-ONLY escape hatch: identifies the request by this header's value
// instead of req.ip, but ONLY when NODE_ENV !== "production" (checked at
// request time, not at module load, so it responds to test setup that
// changes process.env.NODE_ENV). This exists because every request
// against this API in a single-container dev/test/k6 environment shares
// the same source IP (127.0.0.1 or the container's address), which makes
// it impossible to exercise "separate client buckets" behavior without
// some way to assert a distinct identity per simulated client.
//
// This header is NOT a security or trust mechanism: it is trivially
// spoofable by anyone who can send an HTTP request, which is exactly why
// it is refused outright once NODE_ENV === "production". Unlike
// X-Forwarded-For, which this middleware never reads at all, there is no
// attempt to "trust" this header in any deployment configuration --
// it is a hard-coded development/test convenience, gated by environment.
const TEST_CLIENT_ID_HEADER = "x-test-client-id";

export function defaultIdentify(req: Request): string {
  if (process.env.NODE_ENV !== "production") {
    const testClientId = req.header(TEST_CLIENT_ID_HEADER);
    if (testClientId) {
      return `test:${testClientId}`;
    }
  }
  // req.ip reflects Express's own resolution of the socket's remote
  // address. Express's `trust proxy` setting defaults to false (and is
  // never enabled anywhere in this codebase), so req.ip is NOT derived
  // from X-Forwarded-For or any other client-supplied header -- it is
  // the actual TCP connection's remote address, which a client cannot
  // spoof from outside a trusted proxy hop.
  return req.ip ?? "unknown";
}

export function createRateLimiter(options: RateLimiterOptions): RequestHandler {
  const { capacity, windowSeconds, identify = defaultIdentify, now = Date.now } = options;

  if (capacity <= 0) {
    throw new Error("createRateLimiter: capacity must be > 0");
  }
  if (windowSeconds <= 0) {
    throw new Error("createRateLimiter: windowSeconds must be > 0");
  }

  const refillTokensPerMs = capacity / (windowSeconds * 1000);
  const buckets = new Map<string, Bucket>();

  function getOrRefillBucket(key: string, nowMs: number): Bucket {
    const existing = buckets.get(key);

    if (!existing) {
      const fresh: Bucket = { tokens: capacity, lastRefillMs: nowMs };
      buckets.set(key, fresh);
      return fresh;
    }

    const elapsedMs = nowMs - existing.lastRefillMs;
    if (elapsedMs > 0) {
      existing.tokens = Math.min(capacity, existing.tokens + elapsedMs * refillTokensPerMs);
      existing.lastRefillMs = nowMs;
    }
    return existing;
  }

  return function rateLimiter(req: Request, res: Response, next: NextFunction): void {
    const key = identify(req);
    const nowMs = now();
    const bucket = getOrRefillBucket(key, nowMs);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      next();
      return;
    }

    // Retry-After derived from the ACTUAL refill rate: how many
    // milliseconds until this specific bucket has >=1 token again, not a
    // fixed/guessed value.
    const tokensNeeded = 1 - bucket.tokens;
    const msUntilNextToken = tokensNeeded / refillTokensPerMs;
    const retryAfterSeconds = Math.max(1, Math.ceil(msUntilNextToken / 1000));

    res.setHeader("Retry-After", String(retryAfterSeconds));
    res.status(429).json({
      error: "Too many requests",
      reason: "rate_limited",
    });
  };
}
