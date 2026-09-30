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
//     [ENV_FILE=infra/.env.production] \
//     node apps/api/scripts/verify-chaos.js
//
// Requires `docker compose` to be runnable from this shell against the
// already-running stack (same machine, same working directory context
// as when you brought the stack up).
//
// Phase 17 addendum -- real bug found and fixed here: every
// `docker compose` command this script runs MUST use the same
// --env-file the stack was actually started with
// (infra/.env.production -- see docs/deployment.md's "Startup
// procedure"). Without it, `docker compose stop/start` cannot resolve
// this project's required interpolated variables (POSTGRES_PASSWORD,
// RABBITMQ_PASSWORD, ...) and fails immediately, BEFORE touching any
// container. A real run hit exactly this: `stop postgres` and
// `stop rabbitmq` both failed with "variable is missing", so neither
// service was ever actually stopped -- readiness stayed
// {"postgres":"ok","rabbitmq":"ok"} throughout, and the script's old
// step-independent structure let later steps ("readiness recovers")
// report PASS anyway, because nothing had ever gone down to recover
// from. Both problems are fixed below: every compose command now
// passes --env-file, and the pass/fail logic for each service's outage
// is now a single dependent sequence -- "recovers" can only be
// asserted true if the outage was actually, verifiably observed first.

const { execSync } = require("child_process");
const fs = require("fs");

const DASHBOARD_URL = (process.env.DASHBOARD_URL || "http://localhost:8080").replace(/\/$/, "");
const API_KEY = process.env.API_KEY;
const COMPOSE_FILE = process.env.COMPOSE_FILE || "infra/docker-compose.prod.yml";
const ENV_FILE = process.env.ENV_FILE || "infra/.env.production";
const RECOVERY_TIMEOUT_MS = Number(process.env.RECOVERY_TIMEOUT_MS || 60000);

if (require.main === module && !API_KEY) {
  console.error("verify-chaos: API_KEY environment variable is required.");
  process.exit(1);
}

function log(msg) {
  console.log(`[verify-chaos ${new Date().toISOString()}] ${msg}`);
}

// Extracted as a pure function (no side effects) so it can be tested
// directly -- see scripts/__tests__/composeCommand.test.js -- without
// needing Docker or a live stack. This is the exact fix for the real
// bug above: every compose invocation goes through this one function,
// so --env-file is applied consistently everywhere (stop, start, and
// the emergency restore-on-crash path at the bottom of this file) with
// nothing to fall out of sync.
function buildComposeCommand(composeFile, envFile, args) {
  return `docker compose -f ${composeFile} --env-file ${envFile} ${args}`;
}

function compose(args) {
  const cmd = buildComposeCommand(COMPOSE_FILE, ENV_FILE, args);
  log(`$ ${cmd}`);
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    // execSync's thrown error already carries err.stdout/err.stderr,
    // but they're easy to lose in a generic catch -- surface stderr
    // explicitly so a failure like a missing --env-file variable is
    // immediately visible in this script's own output, not just in a
    // buried exception message.
    const stderr = err && err.stderr ? String(err.stderr).trim() : "";
    throw new Error(`command failed: ${cmd}${stderr ? `\n${stderr}` : ""}`);
  }
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

function record(name, ok, reason) {
  results.push({ name, ok, reason });
  log(`${ok ? "PASS" : "FAIL"}: ${name}${reason ? " -- " + reason : ""}`);
}

// One dependent sequence per dependency (postgres / rabbitmq), instead
// of independent steps that each ran regardless of what came before.
// This is the fix for the second real bug: "readiness recovers" can
// now only be recorded true if the outage was actually, verifiably
// observed (readiness genuinely reported this service as failing)
// AND the restart command itself succeeded. If either precondition
// isn't met, "recovers" is recorded FALSE with an explicit reason --
// it is never silently skipped in a way that could read as a pass.
async function runOutageSequence(serviceName, statusField) {
  log(`=== ${serviceName} outage sequence ===`);

  let stopOk = false;
  try {
    compose(`stop ${serviceName}`);
    stopOk = true;
    record(`Stop ${serviceName}`, true);
  } catch (err) {
    record(`Stop ${serviceName}`, false, err.message);
  }

  if (!stopOk) {
    record(
      `${serviceName} outage sequence aborted`,
      false,
      `stop ${serviceName} failed -- cannot safely continue this dependency's chaos sequence (see docs/deployment.md's Startup procedure for the required --env-file)`
    );
    // Nothing was stopped, so there is nothing to restore -- but
    // attempt a `start` anyway in case the failure happened partway
    // through Docker's own handling of the command; harmless no-op if
    // the service was never touched.
    try {
      compose(`start ${serviceName}`);
    } catch {
      // best-effort
    }
    return;
  }

  await sleep(2000);

  const liveDuringOutage = await getLive();
  record(
    `API stays alive (liveness) while ${serviceName} is down`,
    liveDuringOutage.status === 200,
    liveDuringOutage.status !== 200 ? `liveness returned ${liveDuringOutage.status}` : undefined
  );

  const readyDuringOutage = await getReady();
  const outageObserved =
    readyDuringOutage.status === 503 && readyDuringOutage.body && readyDuringOutage.body[statusField] === "error";
  record(
    `Readiness correctly reports ${serviceName} as failing`,
    outageObserved,
    outageObserved
      ? undefined
      : `expected 503/${statusField}:error, got ${readyDuringOutage.status} ${JSON.stringify(readyDuringOutage.body)}`
  );

  let restartOk = false;
  try {
    compose(`start ${serviceName}`);
    restartOk = true;
    record(`Restart ${serviceName}`, true);
  } catch (err) {
    record(`Restart ${serviceName}`, false, err.message);
  }

  // The dependent gate: "recovers" is only ever asserted true if the
  // outage was genuinely observed AND the restart command succeeded.
  // Either failure makes recovery unverifiable, not something to
  // silently skip -- record it as a real failure with the reason.
  if (!outageObserved) {
    record(
      `Readiness recovers (${serviceName})`,
      false,
      `not verifiable -- the outage itself was never observed (readiness never reported ${serviceName}:error), so recovery cannot be meaningfully asserted`
    );
    return;
  }
  if (!restartOk) {
    record(`Readiness recovers (${serviceName})`, false, `restart command failed, cannot verify recovery`);
    return;
  }

  const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
  let recovered = false;
  let last;
  while (Date.now() < deadline) {
    last = await getReady();
    if (last.status === 200 && last.body && last.body[statusField] === "ok") {
      recovered = true;
      break;
    }
    await sleep(1000);
  }
  record(
    `Readiness recovers (${serviceName})`,
    recovered,
    recovered ? undefined : `did not recover within ${RECOVERY_TIMEOUT_MS}ms; last=${JSON.stringify(last)}`
  );

  if (!recovered) {
    return;
  }

  const workerResult = await createJobAndWaitForCompletion(`after-${serviceName}-outage`, 30000);
  record(`Worker recovers: a real job submitted after ${serviceName} recovery completes`, workerResult.ok, workerResult.reason);
}

async function main() {
  log(`Chaos smoke test against ${DASHBOARD_URL} using ${COMPOSE_FILE} (--env-file ${ENV_FILE})`);

  if (!fs.existsSync(ENV_FILE)) {
    console.error(
      `Aborting: ENV_FILE '${ENV_FILE}' does not exist. This must be the same env file the stack was started ` +
        `with (see docs/deployment.md's "Startup procedure") -- without it, docker compose cannot resolve this ` +
        `project's required variables and every stop/start command will fail before touching any container. ` +
        `Set ENV_FILE=<path> if your real file lives somewhere else.`
    );
    process.exit(1);
  }

  // Fail fast and loud on exactly the class of problem that caused the
  // real bug this addendum fixes: if docker compose can't even resolve
  // its config with this compose file + env file, nothing below this
  // point can be trusted, so don't proceed and risk a false PASS.
  try {
    compose("config --quiet");
  } catch (err) {
    console.error(`Aborting: docker compose could not resolve its configuration with ${COMPOSE_FILE} and --env-file ${ENV_FILE}:\n${err.message}`);
    process.exit(1);
  }

  const baseline = await getReady();
  if (baseline.status !== 200) {
    console.error(`Aborting: baseline readiness check did not return 200 (got ${baseline.status}). Fix the stack before running chaos tests.`);
    process.exit(1);
  }
  log(`Baseline readiness OK: ${JSON.stringify(baseline.body)}`);

  await runOutageSequence("postgres", "postgres");
  await runOutageSequence("rabbitmq", "rabbitmq");

  console.log("\n--- Summary ---");
  let allOk = true;
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.reason ? " -- " + r.reason : ""}`);
    if (!r.ok) allOk = false;
  }
  console.log(`\nOverall: ${allOk ? "ALL PASSED" : "AT LEAST ONE FAILURE -- see above"}`);
  process.exit(allOk ? 0 : 1);
}

module.exports = { buildComposeCommand };

if (require.main === module) {
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
}
