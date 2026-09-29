#!/usr/bin/env node
// Phase 17: production failure/chaos smoke tests against the REAL
// running docker-compose.prod.yml stack. This is a smoke test, not a
// replacement for Phase 15's deeper chaos validation -- it exists to
// give a fast, deterministic, repeatable "is the deployed system still
// resilient the way Phase 15 proved the local dev topology was" check.
//
// Safety: uses `docker compose stop/start` on individual services only
// -- NEVER `down -v` or anything that touches the postgres_data /
// rabbitmq_data volumes. Restores every service it stops, even on
// failure (best-effort, via a finally-style cleanup).
//
// Usage (from the repository root):
//
//   DASHBOARD_URL=http://localhost:8080 API_KEY=<your real API key> \
//     [COMPOSE_FILE=infra/docker-compose.prod.yml] \
//     node apps/api/scripts/verify-chaos.js
//
// Requires `docker compose` to be runnable from this shell against the
// already-running stack (same machine, same working directory context
// as when you brought the stack up).

const { execSync } = require("child_process");

const DASHBOARD_URL = (process.env.DASHBOARD_URL || "http://localhost:8080").replace(/\/$/, "");
const API_KEY = process.env.API_KEY;
const COMPOSE_FILE = process.env.COMPOSE_FILE || "infra/docker-compose.prod.yml";
const RECOVERY_TIMEOUT_MS = Number(process.env.RECOVERY_TIMEOUT_MS || 60000);

if (!API_KEY) {
  console.error("verify-chaos: API_KEY environment variable is required.");
  process.exit(1);
}

function log(msg) {
  console.log(`[verify-chaos ${new Date().toISOString()}] ${msg}`);
}

function compose(args) {
  const cmd = `docker compose -f ${COMPOSE_FILE} ${args}`;
  log(`$ ${cmd}`);
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getReady() {
  try {
    const res = await fetch(`${DASHBOARD_URL}/api/health/ready`);
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  } catch (err) {
    return { status: null, error: String(err) };
  }
}

async function getLive() {
  try {
    const res = await fetch(`${DASHBOARD_URL}/api/health`);
    return { status: res.status };
  } catch (err) {
    return { status: null, error: String(err) };
  }
}

async function createJobAndWaitForCompletion(label, timeoutMs) {
  const createRes = await fetch(`${DASHBOARD_URL}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
    body: JSON.stringify({ type: "chaos-verification", payload: { label, at: Date.now() } }),
  });
  if (!createRes.ok) {
    return { ok: false, reason: `job creation returned HTTP ${createRes.status}` };
  }
  const { jobId } = await createRes.json();
  log(`  created job ${jobId}, waiting up to ${timeoutMs}ms for COMPLETED...`);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${DASHBOARD_URL}/api/jobs/${jobId}`);
    if (res.ok) {
      const job = await res.json();
      if (job.status === "COMPLETED") {
        return { ok: true, jobId, attemptCount: job.attempt_count };
      }
      if (job.status === "DEAD_LETTERED") {
        return { ok: false, reason: `job ${jobId} was DEAD_LETTERED instead of completing`, job };
      }
    }
    await sleep(1000);
  }
  return { ok: false, reason: `job ${jobId} did not reach COMPLETED within ${timeoutMs}ms` };
}

const results = [];

async function step(name, fn) {
  log(`--- ${name} ---`);
  try {
    const result = await fn();
    results.push({ name, ...result });
    log(`${result.ok ? "PASS" : "FAIL"}: ${name}${result.reason ? " -- " + result.reason : ""}`);
  } catch (err) {
    results.push({ name, ok: false, reason: String(err) });
    log(`FAIL (exception): ${name} -- ${err}`);
  }
}

async function main() {
  log(`Chaos smoke test against ${DASHBOARD_URL} using ${COMPOSE_FILE}`);

  const baseline = await getReady();
  if (baseline.status !== 200) {
    console.error(`Aborting: baseline readiness check did not return 200 (got ${baseline.status}). Fix the stack before running chaos tests.`);
    process.exit(1);
  }
  log(`Baseline readiness OK: ${JSON.stringify(baseline.body)}`);

  // --- PostgreSQL outage ---
  await step("Stop postgres", async () => {
    compose("stop postgres");
    return { ok: true };
  });

  await sleep(2000);

  await step("API stays alive (liveness) while Postgres is down", async () => {
    const live = await getLive();
    return { ok: live.status === 200, reason: live.status !== 200 ? `liveness returned ${live.status}` : undefined, detail: live };
  });

  await step("Readiness correctly reports Postgres as failing", async () => {
    const ready = await getReady();
    const ok = ready.status === 503 && ready.body && ready.body.postgres === "error";
    return { ok, reason: ok ? undefined : `expected 503/postgres:error, got ${ready.status} ${JSON.stringify(ready.body)}` };
  });

  await step("Restart postgres", async () => {
    compose("start postgres");
    return { ok: true };
  });

  await step("Readiness recovers (postgres:ok) after restart", async () => {
    const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
    let last;
    while (Date.now() < deadline) {
      last = await getReady();
      if (last.status === 200 && last.body && last.body.postgres === "ok") {
        return { ok: true };
      }
      await sleep(1000);
    }
    return { ok: false, reason: `did not recover within ${RECOVERY_TIMEOUT_MS}ms; last=${JSON.stringify(last)}` };
  });

  await step("Worker recovers: a real job submitted after Postgres recovery completes", async () => {
    return createJobAndWaitForCompletion("after-postgres-outage", 30000);
  });

  // --- RabbitMQ outage ---
  await step("Stop rabbitmq", async () => {
    compose("stop rabbitmq");
    return { ok: true };
  });

  await sleep(2000);

  await step("API stays alive (liveness) while RabbitMQ is down", async () => {
    const live = await getLive();
    return { ok: live.status === 200, reason: live.status !== 200 ? `liveness returned ${live.status}` : undefined };
  });

  await step("Readiness correctly reports RabbitMQ as failing", async () => {
    const ready = await getReady();
    const ok = ready.status === 503 && ready.body && ready.body.rabbitmq === "error";
    return { ok, reason: ok ? undefined : `expected 503/rabbitmq:error, got ${ready.status} ${JSON.stringify(ready.body)}` };
  });

  await step("Restart rabbitmq", async () => {
    compose("start rabbitmq");
    return { ok: true };
  });

  await step("Readiness recovers (rabbitmq:ok) after restart", async () => {
    const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
    let last;
    while (Date.now() < deadline) {
      last = await getReady();
      if (last.status === 200 && last.body && last.body.rabbitmq === "ok") {
        return { ok: true };
      }
      await sleep(1000);
    }
    return { ok: false, reason: `did not recover within ${RECOVERY_TIMEOUT_MS}ms; last=${JSON.stringify(last)}` };
  });

  await step("Worker recovers: a real job submitted after RabbitMQ recovery completes", async () => {
    return createJobAndWaitForCompletion("after-rabbitmq-outage", 30000);
  });

  console.log("\n--- Summary ---");
  let allOk = true;
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.reason ? " -- " + r.reason : ""}`);
    if (!r.ok) allOk = false;
  }
  console.log(`\nOverall: ${allOk ? "ALL PASSED" : "AT LEAST ONE FAILURE -- see above"}`);
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error(`verify-chaos: unexpected error: ${err instanceof Error ? err.stack : String(err)}`);
  console.error("Attempting to restore postgres/rabbitmq before exiting...");
  try {
    compose("start postgres");
    compose("start rabbitmq");
  } catch {
    // best-effort
  }
  process.exit(1);
});
