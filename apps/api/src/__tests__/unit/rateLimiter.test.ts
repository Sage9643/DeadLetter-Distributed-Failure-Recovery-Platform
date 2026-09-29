import { createRateLimiter, defaultIdentify } from "../../middleware/rateLimiter";
import type { Request } from "express";

// These tests call the middleware directly with hand-built mock
// req/res/next objects rather than going through supertest+Express. The
// middleware only ever touches req.ip, req.header(), res.setHeader(),
// res.status(), res.json() and next() -- minimal mocks are sufficient and
// keep the clock fully deterministic via the injectable `now` option,
// with no real timers/sleeps anywhere in this file.

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    ip: "127.0.0.1",
    header: (_name: string) => undefined,
    ...overrides,
  } as unknown as Request;
}

interface MockRes {
  statusCode: number | null;
  headers: Record<string, string>;
  body: unknown;
  status: (code: number) => MockRes;
  json: (body: unknown) => MockRes;
  setHeader: (name: string, value: string) => void;
}

function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: null,
    headers: {},
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
    setHeader(name: string, value: string) {
      res.headers[name.toLowerCase()] = value;
    },
  };
  return res;
}

describe("createRateLimiter", () => {
  describe("requests within allowance", () => {
    it("admits every request up to the configured capacity", () => {
      const limiter = createRateLimiter({ capacity: 5, windowSeconds: 60, now: () => 0 });
      const req = mockReq();

      for (let i = 0; i < 5; i++) {
        const res = mockRes();
        const next = jest.fn();
        limiter(req, res as unknown as import("express").Response, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBeNull();
      }
    });
  });

  describe("request exceeding allowance", () => {
    it("returns 429 once capacity is exhausted, and calls next() zero times for the rejected request", () => {
      const limiter = createRateLimiter({ capacity: 2, windowSeconds: 60, now: () => 0 });
      const req = mockReq();

      for (let i = 0; i < 2; i++) {
        const next = jest.fn();
        limiter(req, mockRes() as unknown as import("express").Response, next);
        expect(next).toHaveBeenCalledTimes(1);
      }

      const res = mockRes();
      const next = jest.fn();
      limiter(req, res as unknown as import("express").Response, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(429);
      expect(res.body).toEqual({ error: "Too many requests", reason: "rate_limited" });
    });
  });

  describe("Retry-After", () => {
    it("includes a positive integer Retry-After header (in seconds) on a 429", () => {
      const limiter = createRateLimiter({ capacity: 1, windowSeconds: 60, now: () => 0 });
      const req = mockReq();

      limiter(req, mockRes() as unknown as import("express").Response, jest.fn());

      const res = mockRes();
      limiter(req, res as unknown as import("express").Response, jest.fn());

      expect(res.statusCode).toBe(429);
      expect(res.headers["retry-after"]).toBeDefined();
      const retryAfter = Number(res.headers["retry-after"]);
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThan(0);
    });

    it("derives Retry-After from the actual configured refill rate (capacity=1, windowSeconds=10 => ~10s to regain the single token)", () => {
      const limiter = createRateLimiter({ capacity: 1, windowSeconds: 10, now: () => 0 });
      const req = mockReq();

      limiter(req, mockRes() as unknown as import("express").Response, jest.fn());

      const res = mockRes();
      limiter(req, res as unknown as import("express").Response, jest.fn());

      // capacity/windowSeconds = 0.1 tokens/sec => 1 full token takes 10s.
      expect(Number(res.headers["retry-after"])).toBe(10);
    });
  });

  describe("refill behavior", () => {
    it("admits a new request once enough simulated time has passed for a token to refill", () => {
      let currentTime = 0;
      const limiter = createRateLimiter({ capacity: 1, windowSeconds: 10, now: () => currentTime });
      const req = mockReq();

      // Exhaust the single token.
      limiter(req, mockRes() as unknown as import("express").Response, jest.fn());

      // Immediately retrying is rejected.
      const rejected = mockRes();
      limiter(req, rejected as unknown as import("express").Response, jest.fn());
      expect(rejected.statusCode).toBe(429);

      // Advance simulated time by exactly the full window (10s) -- bucket
      // should be back to full capacity.
      currentTime += 10_000;

      const admitted = mockRes();
      const next = jest.fn();
      limiter(req, admitted as unknown as import("express").Response, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(admitted.statusCode).toBeNull();
    });

    it("refills partially, not just all-or-nothing", () => {
      let currentTime = 0;
      const limiter = createRateLimiter({ capacity: 2, windowSeconds: 10, now: () => currentTime });
      const req = mockReq();

      // Drain both tokens.
      limiter(req, mockRes() as unknown as import("express").Response, jest.fn());
      limiter(req, mockRes() as unknown as import("express").Response, jest.fn());

      // Advance by half the window (5s) -- refill rate is 0.2 tokens/sec,
      // so 5s yields exactly 1 token back, not 2.
      currentTime += 5_000;

      const first = mockRes();
      const firstNext = jest.fn();
      limiter(req, first as unknown as import("express").Response, firstNext);
      expect(firstNext).toHaveBeenCalledTimes(1);

      const second = mockRes();
      const secondNext = jest.fn();
      limiter(req, second as unknown as import("express").Response, secondNext);
      expect(secondNext).not.toHaveBeenCalled();
      expect(second.statusCode).toBe(429);
    });
  });

  describe("separate client buckets", () => {
    it("does not let one client's exhausted bucket affect a different client", () => {
      const limiter = createRateLimiter({ capacity: 1, windowSeconds: 60, now: () => 0 });
      const clientA = mockReq({ ip: "10.0.0.1" });
      const clientB = mockReq({ ip: "10.0.0.2" });

      limiter(clientA, mockRes() as unknown as import("express").Response, jest.fn());

      const aRejected = mockRes();
      limiter(clientA, aRejected as unknown as import("express").Response, jest.fn());
      expect(aRejected.statusCode).toBe(429);

      const bRes = mockRes();
      const bNext = jest.fn();
      limiter(clientB, bRes as unknown as import("express").Response, bNext);
      expect(bNext).toHaveBeenCalledTimes(1);
      expect(bRes.statusCode).toBeNull();
    });
  });

  describe("shared client bucket", () => {
    it("shares one bucket across multiple calls with the same identity, as required for POST /api/jobs and POST /api/jobs/:id/replay to share ONE limiter instance", () => {
      const limiter = createRateLimiter({ capacity: 3, windowSeconds: 60, now: () => 0 });
      const req = mockReq({ ip: "10.0.0.5" });

      // Simulates 2 calls against one route and 1 against another, all
      // through the SAME limiter instance/bucket -- this is exactly how
      // routes/jobs.ts wires a single shared createRateLimiter() result
      // into both POST / and POST /:id/replay.
      const results = [1, 2, 3].map(() => {
        const res = mockRes();
        const next = jest.fn();
        limiter(req, res as unknown as import("express").Response, next);
        return { res, next };
      });

      expect(results.every((r) => r.next.mock.calls.length === 1)).toBe(true);

      const fourth = mockRes();
      limiter(req, fourth as unknown as import("express").Response, jest.fn());
      expect(fourth.statusCode).toBe(429);
    });
  });

  describe("development test-client identity", () => {
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = originalNodeEnv;
    });

    it("uses the X-Test-Client-Id header instead of req.ip when NODE_ENV !== 'production'", () => {
      process.env.NODE_ENV = "test";
      const limiter = createRateLimiter({ capacity: 1, windowSeconds: 60, now: () => 0 });

      // Same req.ip, different X-Test-Client-Id -- must be treated as
      // two separate clients.
      const reqA = mockReq({ ip: "127.0.0.1", header: (name) => (name.toLowerCase() === "x-test-client-id" ? "clientA" : undefined) });
      const reqB = mockReq({ ip: "127.0.0.1", header: (name) => (name.toLowerCase() === "x-test-client-id" ? "clientB" : undefined) });

      const aRes = mockRes();
      const aNext = jest.fn();
      limiter(reqA, aRes as unknown as import("express").Response, aNext);
      expect(aNext).toHaveBeenCalledTimes(1);

      const bRes = mockRes();
      const bNext = jest.fn();
      limiter(reqB, bRes as unknown as import("express").Response, bNext);
      expect(bNext).toHaveBeenCalledTimes(1);

      // clientA's single token is now spent -- a second request under
      // the SAME test-client id is rejected even though req.ip is
      // identical to clientB's.
      const aSecondRes = mockRes();
      limiter(reqA, aSecondRes as unknown as import("express").Response, jest.fn());
      expect(aSecondRes.statusCode).toBe(429);
    });

    it("defaultIdentify falls back to req.ip when no X-Test-Client-Id header is present, even outside production", () => {
      process.env.NODE_ENV = "test";
      const req = mockReq({ ip: "10.1.1.1", header: () => undefined });
      expect(defaultIdentify(req)).toBe("10.1.1.1");
    });
  });

  describe("production ignoring X-Test-Client-Id", () => {
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = originalNodeEnv;
    });

    it("falls back to req.ip and ignores X-Test-Client-Id entirely when NODE_ENV === 'production'", () => {
      process.env.NODE_ENV = "production";
      const limiter = createRateLimiter({ capacity: 1, windowSeconds: 60, now: () => 0 });

      const reqA = mockReq({ ip: "192.168.1.1", header: (name) => (name.toLowerCase() === "x-test-client-id" ? "spoofed-a" : undefined) });
      const reqB = mockReq({ ip: "192.168.1.1", header: (name) => (name.toLowerCase() === "x-test-client-id" ? "spoofed-b" : undefined) });

      // Both requests share the same real req.ip, so in production they
      // MUST be treated as the same client despite differing
      // X-Test-Client-Id values -- proving the header is genuinely
      // ignored, not just deprioritized.
      limiter(reqA, mockRes() as unknown as import("express").Response, jest.fn());

      const res = mockRes();
      limiter(reqB, res as unknown as import("express").Response, jest.fn());
      expect(res.statusCode).toBe(429);
    });

    it("defaultIdentify returns req.ip directly in production regardless of the test header", () => {
      process.env.NODE_ENV = "production";
      const req = mockReq({ ip: "8.8.8.8", header: (name) => (name.toLowerCase() === "x-test-client-id" ? "ignored" : undefined) });
      expect(defaultIdentify(req)).toBe("8.8.8.8");
    });
  });
});
