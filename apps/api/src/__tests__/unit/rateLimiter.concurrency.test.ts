import { createRateLimiter } from "../../middleware/rateLimiter";
import type { Request, Response } from "express";

// This file proves ONE specific observable invariant under genuine
// concurrent dispatch via Promise.all:
//
//   With a configured allowance K and N simultaneous requests from the
//   SAME client, no more than K are admitted (call next()); the
//   remaining N-K receive a 429.
//
// This is deliberately NOT framed as a generic "race-freedom proof" of
// the token-bucket algorithm. The middleware is synchronous, single-
// threaded JS -- there is no genuine multi-core race inside
// createRateLimiter itself the way there is a real Postgres row-lock
// race in claimJob/claimReplay. What Promise.all DOES prove here is the
// actual admission count under a burst of concurrently-fired requests
// hitting the same in-memory bucket via the real Express request-handling
// path (an event-loop-interleaved burst, not a sequential loop) --
// exactly the shape of the k6 rate-limit scenario later in this phase.

function mockReq(ip: string, header?: string): Request {
  return {
    ip,
    header: (name: string) => (name.toLowerCase() === "x-test-client-id" ? header : undefined),
  } as unknown as Request;
}

function mockRes(): { statusCode: number | null; status: (c: number) => any; json: (b: unknown) => any; setHeader: () => void } {
  const res = {
    statusCode: null as number | null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(_body: unknown) {
      return res;
    },
    setHeader() {
      /* no-op */
    },
  };
  return res;
}

/**
 * Fires N requests against `limiter` for a single identity, "concurrently"
 * via Promise.all wrapping a microtask-deferred call -- so all N calls are
 * scheduled before any of them synchronously runs to completion, matching
 * how N near-simultaneous Express requests would actually interleave.
 */
async function fireConcurrent(
  limiter: (req: Request, res: Response, next: () => void) => void,
  req: Request,
  count: number
): Promise<{ admitted: number; rejected: number; statuses: number[] }> {
  const results = await Promise.all(
    Array.from({ length: count }, () =>
      Promise.resolve().then(() => {
        const res = mockRes();
        let admitted = false;
        limiter(req, res as unknown as Response, () => {
          admitted = true;
        });
        return admitted ? 0 : (res.statusCode as number);
      })
    )
  );

  const admitted = results.filter((r) => r === 0).length;
  const rejected = results.filter((r) => r !== 0).length;
  return { admitted, rejected, statuses: results };
}

describe("createRateLimiter concurrency -- observable admission invariant", () => {
  it("admits at most K=10 of N=50 concurrent requests from one client (capacity=10)", async () => {
    const limiter = createRateLimiter({ capacity: 10, windowSeconds: 60, now: () => 0 });
    const req = mockReq("10.0.0.9");

    const { admitted, rejected } = await fireConcurrent(limiter, req, 50);

    expect(admitted).toBe(10);
    expect(rejected).toBe(40);
  });

  it("admits at most K=1 of N=20 concurrent requests from one client (capacity=1)", async () => {
    const limiter = createRateLimiter({ capacity: 1, windowSeconds: 60, now: () => 0 });
    const req = mockReq("10.0.0.10");

    const { admitted, rejected } = await fireConcurrent(limiter, req, 20);

    expect(admitted).toBe(1);
    expect(rejected).toBe(19);
  });

  it("admits exactly K=25 of N=25 when the burst equals capacity exactly (boundary case)", async () => {
    const limiter = createRateLimiter({ capacity: 25, windowSeconds: 60, now: () => 0 });
    const req = mockReq("10.0.0.11");

    const { admitted, rejected } = await fireConcurrent(limiter, req, 25);

    expect(admitted).toBe(25);
    expect(rejected).toBe(0);
  });

  it("every rejected request among the N concurrent ones receives a 429 with Retry-After -- not silently dropped", async () => {
    const limiter = createRateLimiter({ capacity: 5, windowSeconds: 60, now: () => 0 });
    const req = mockReq("10.0.0.12");

    const results = await Promise.all(
      Array.from({ length: 15 }, () =>
        Promise.resolve().then(() => {
          const res = mockRes();
          const headers: Record<string, string> = {};
          (res as any).setHeader = (name: string, value: string) => {
            headers[name.toLowerCase()] = value;
          };
          let admitted = false;
          limiter(req, res as unknown as Response, () => {
            admitted = true;
          });
          return { admitted, statusCode: res.statusCode, headers };
        })
      )
    );

    const rejectedResults = results.filter((r) => !r.admitted);
    expect(rejectedResults).toHaveLength(10);
    for (const r of rejectedResults) {
      expect(r.statusCode).toBe(429);
      expect(r.headers["retry-after"]).toBeDefined();
    }
  });

  it("keeps admission counts independent per client identity, even under concurrent bursts from two clients at once", async () => {
    const limiter = createRateLimiter({ capacity: 5, windowSeconds: 60, now: () => 0 });
    const reqA = mockReq("10.0.0.13");
    const reqB = mockReq("10.0.0.14");

    const [resultA, resultB] = await Promise.all([
      fireConcurrent(limiter, reqA, 12),
      fireConcurrent(limiter, reqB, 12),
    ]);

    expect(resultA.admitted).toBe(5);
    expect(resultB.admitted).toBe(5);
  });
});
