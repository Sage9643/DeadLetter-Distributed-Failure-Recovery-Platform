import request from "supertest";
import express from "express";
import { app, TRUST_PROXY_HOPS } from "../../app";
import { pool } from "../../db/pool";
import { createRateLimiter } from "../../middleware/rateLimiter";

// Phase 17 final audit fix: proves app.ts's `app.set("trust proxy",
// TRUST_PROXY_HOPS)` (TRUST_PROXY_HOPS = 1) actually does what its
// comment claims, without needing a live database or the real
// production nginx -- these tests build isolated Express apps that
// mirror the real app's trust-proxy configuration and drive them with
// real HTTP requests via supertest, so Express's own trust-proxy
// resolution (a real library mechanism, not something this project
// implements) is genuinely exercised, not mocked.
//
// `app` itself is imported (not just TRUST_PROXY_HOPS) so the first
// test below proves the REAL production app actually applies this
// setting, not just that the constant has the right value.

afterAll(async () => {
  // Importing ../../app transitively imports db/pool.ts, which opens a
  // real `pg.Pool` (lazily -- see poolErrorHandling.test.ts and
  // healthRoute.test.ts for the same pattern). No query is ever made
  // by these tests, so no reachable Postgres is required, but the
  // pool handle still needs closing so Jest can exit cleanly.
  await pool.end();
});

describe("trust proxy configuration on the real app (Phase 17 final audit fix)", () => {
  it("TRUST_PROXY_HOPS is exactly 1, not true/unbounded", () => {
    expect(TRUST_PROXY_HOPS).toBe(1);
  });

  it("the real, exported production app has trust proxy set to exactly 1", () => {
    expect(app.get("trust proxy")).toBe(1);
    // Express normalizes a numeric trust-proxy value to a function
    // internally, but the configured value itself must be the literal
    // number 1 -- not the boolean `true`, which a loose equality check
    // could otherwise be fooled by (1 == true in JS). Explicit strict
    // checks against both wrong shapes:
    expect(app.get("trust proxy")).not.toBe(true);
    expect(typeof app.get("trust proxy")).not.toBe("boolean");
  });
});

// Isolated test apps below use a FRESH rate limiter and FRESH Express
// app per test (not the real, DB-backed jobsRouter) so this file has
// no database dependency at all, while still exercising the exact
// same two real mechanisms the production app relies on: Express's
// trust-proxy resolution of req.ip, and rateLimiter.ts's
// defaultIdentify() bucketing by that same req.ip. Both apps set
// `trust proxy` to the SAME TRUST_PROXY_HOPS constant app.ts uses, so
// this is a faithful reproduction of the real configuration, not a
// separately-invented one.
function buildTestApp(capacity: number): express.Express {
  const testApp = express();
  testApp.set("trust proxy", TRUST_PROXY_HOPS);
  testApp.use(createRateLimiter({ capacity, windowSeconds: 60 }));
  testApp.get("/probe", (req, res) => {
    res.status(200).json({ ip: req.ip });
  });
  return testApp;
}

describe("rate limiter correctly distinguishes clients behind one trusted proxy hop", () => {
  it("two different real clients, each presented through the one trusted hop via a distinct X-Forwarded-For value, get SEPARATE rate-limit buckets", async () => {
    // capacity: 1 -- a second request from the SAME client must be
    // rejected, proving a genuine per-identity bucket exists at all.
    const testApp = buildTestApp(1);
    const clientA = "203.0.113.10";
    const clientB = "203.0.113.20";

    const a1 = await request(testApp).get("/probe").set("X-Forwarded-For", clientA);
    expect(a1.status).toBe(200);
    expect(a1.body.ip).toBe(clientA);

    // Client B's first request must NOT be rejected by client A's
    // now-exhausted bucket -- this is the exact bug this fix closes:
    // before it, both would have resolved to the same (nginx) address
    // and B would have been wrongly rejected here.
    const b1 = await request(testApp).get("/probe").set("X-Forwarded-For", clientB);
    expect(b1.status).toBe(200);
    expect(b1.body.ip).toBe(clientB);

    // Client A's OWN second request, however, must now be rejected --
    // proving this isn't simply "rate limiting silently disabled",
    // only that identity is now correctly per-client.
    const a2 = await request(testApp).get("/probe").set("X-Forwarded-For", clientA);
    expect(a2.status).toBe(429);
  });

  it("without any X-Forwarded-For header, still resolves to the real connecting peer (no proxy in the loop, as in local dev/test)", async () => {
    const testApp = buildTestApp(100);
    const res = await request(testApp).get("/probe");
    expect(res.status).toBe(200);
    expect(typeof res.body.ip).toBe("string");
    expect(res.body.ip.length).toBeGreaterThan(0);
  });
});

describe("a forged, multi-entry X-Forwarded-For chain cannot spoof an arbitrary client identity", () => {
  it("trust proxy=1 uses ONLY the entry the one trusted hop itself appended, ignoring an earlier attacker-claimed entry in the same header", async () => {
    const testApp = buildTestApp(100);
    // Simulates a caller trying to inject a fake upstream hop ahead of
    // the real one, hoping Express will believe the EARLIER (client
    // -controlled) entry is the "original" client. Real, verified
    // Express/proxy-addr behavior with trust proxy=1: it walks back
    // exactly ONE hop from the connecting peer and returns that
    // entry -- the LAST one in the header -- never the first.
    const res = await request(testApp)
      .get("/probe")
      .set("X-Forwarded-For", "9.9.9.9, 8.8.8.8");

    expect(res.status).toBe(200);
    expect(res.body.ip).toBe("8.8.8.8");
    expect(res.body.ip).not.toBe("9.9.9.9");
  });

  it("documents, by direct contrast, why trust proxy=true (rejected in app.ts) would NOT be safe: it trusts the entire attacker-claimed chain, including the earliest, unverified entry", async () => {
    // Not this project's configuration -- a dedicated app built with
    // trust proxy: true, purely to prove by contrast why app.ts
    // deliberately does NOT use it. This is the exact vulnerability
    // TRUST_PROXY_HOPS = 1 avoids.
    const trueApp = express();
    trueApp.set("trust proxy", true);
    trueApp.get("/probe", (req, res) => res.status(200).json({ ip: req.ip }));

    const res = await request(trueApp)
      .get("/probe")
      .set("X-Forwarded-For", "9.9.9.9, 8.8.8.8");

    expect(res.status).toBe(200);
    // With trust proxy=true, Express believes the FIRST (client
    // -supplied, unverified) entry -- exactly what an attacker
    // directly reaching this hypothetical app could forge freely.
    expect(res.body.ip).toBe("9.9.9.9");
  });
});
