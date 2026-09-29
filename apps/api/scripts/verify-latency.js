#!/usr/bin/env node
// Phase 17: real latency measurement against a running deployment.
// Repeated real requests -- no estimates, no invented numbers. Reports
// p50/p95/p99 (and min/max) for each measured path.
//
// Usage (from the repository root, after infra/docker-compose.prod.yml
// is up and healthy):
//
//   DASHBOARD_URL=http://localhost:8080 API_KEY=<your real API key> \
//     [API_DIRECT_URL=http://localhost:3000] \
//     [REQUEST_COUNT=50] \
//     node apps/api/scripts/verify-latency.js
//
// API_DIRECT_URL is optional -- set it only if the api container's
// port is temporarily published to the host (e.g. `ports: ["3000:3000"]`
// added just for this comparison, then removed again) so the nginx-
// proxy-overhead comparison can be computed. Without it, this script
// still measures the real public (nginx) path and simply skips the
// comparison.

const DASHBOARD_URL = (process.env.DASHBOARD_URL || "http://localhost:8080").replace(/\/$/, "");
const API_DIRECT_URL = process.env.API_DIRECT_URL ? process.env.API_DIRECT_URL.replace(/\/$/, "") : null;
const API_KEY = process.env.API_KEY;
const REQUEST_COUNT = Number(process.env.REQUEST_COUNT || 50);

if (!API_KEY) {
  console.error("verify-latency: API_KEY environment variable is required.");
  process.exit(1);
}

function percentile(sortedMs, p) {
  if (sortedMs.length === 0) return null;
  const idx = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1);
  return sortedMs[Math.max(0, idx)];
}

function summarize(label, samples) {
  const ok = samples.filter((s) => s.ok).map((s) => s.ms).sort((a, b) => a - b);
  const failed = samples.filter((s) => !s.ok);
  console.log(`\n${label}`);
  console.log(`  requests: ${samples.length}, succeeded: ${ok.length}, failed: ${failed.length}`);
  if (ok.length > 0) {
    console.log(`  min: ${ok[0].toFixed(1)}ms  p50: ${percentile(ok, 50).toFixed(1)}ms  p95: ${percentile(ok, 95).toFixed(1)}ms  p99: ${percentile(ok, 99).toFixed(1)}ms  max: ${ok[ok.length - 1].toFixed(1)}ms`);
  }
  if (failed.length > 0) {
    console.log(`  sample failure: ${failed[0].error}`);
  }
  return { label, count: samples.length, ok: ok.length, failed: failed.length, p50: percentile(ok, 50), p95: percentile(ok, 95) };
}

async function timeRequest(fn) {
  const start = performance.now();
  try {
    const res = await fn();
    const ms = performance.now() - start;
    if (!res.ok) {
      return { ok: false, ms, error: `HTTP ${res.status}` };
    }
    // Drain the body so keep-alive/connection reuse behaves normally.
    await res.text().catch(() => {});
    return { ok: true, ms };
  } catch (err) {
    return { ok: false, ms: performance.now() - start, error: String(err) };
  }
}

async function measure(label, count, fn) {
  const samples = [];
  for (let i = 0; i < count; i++) {
    samples.push(await timeRequest(fn));
  }
  return summarize(label, samples);
}

async function main() {
  console.log(`Latency validation against ${DASHBOARD_URL} (${REQUEST_COUNT} requests per path)`);
  const results = [];

  results.push(
    await measure(`GET ${DASHBOARD_URL}/api/health (liveness, via nginx)`, REQUEST_COUNT, () =>
      fetch(`${DASHBOARD_URL}/api/health`)
    )
  );

  results.push(
    await measure(`GET ${DASHBOARD_URL}/api/health/ready (readiness, via nginx)`, REQUEST_COUNT, () =>
      fetch(`${DASHBOARD_URL}/api/health/ready`)
    )
  );

  results.push(
    await measure(`POST ${DASHBOARD_URL}/api/jobs (authenticated job creation, via nginx)`, REQUEST_COUNT, () =>
      fetch(`${DASHBOARD_URL}/api/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
        body: JSON.stringify({ type: "latency-verification", payload: { at: Date.now() } }),
      })
    )
  );

  if (API_DIRECT_URL) {
    results.push(
      await measure(`GET ${API_DIRECT_URL}/api/health (liveness, DIRECT to api, no nginx)`, REQUEST_COUNT, () =>
        fetch(`${API_DIRECT_URL}/api/health`)
      )
    );
    const proxied = results.find((r) => r.label.startsWith("GET") && r.label.includes("via nginx") && r.label.includes("health ("));
    const direct = results[results.length - 1];
    if (proxied && direct && proxied.p50 != null && direct.p50 != null) {
      console.log(`\nProxy overhead estimate (health endpoint, p50): ${(proxied.p50 - direct.p50).toFixed(1)}ms (nginx path minus direct path)`);
    }
  } else {
    console.log(`\n(API_DIRECT_URL not set -- skipping nginx-vs-direct-API comparison. See this script's header for how to enable it.)`);
  }

  console.log("\n--- Summary (JSON, for pasting back) ---");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(`verify-latency: unexpected error: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
