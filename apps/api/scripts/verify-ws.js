#!/usr/bin/env node
// Phase 17: deterministic WebSocket production validation.
//
// What this proves, end to end, through the REAL deployed stack (not
// a unit test with a mocked WebSocketServer): a browser connecting to
// the dashboard's own origin at /ws -- exactly the path nginx
// reverse-proxies to the api container (see apps/dashboard/nginx.conf)
// -- receives a real job.updated broadcast when a job created through
// the same public entry point changes state.
//
// Usage (from the repository root, after `infra/docker-compose.prod.yml`
// is up and healthy):
//
//   DASHBOARD_URL=http://localhost:8080 API_KEY=<your real API key> \
//     node apps/api/scripts/verify-ws.js
//
// DASHBOARD_URL defaults to http://localhost:8080 (matching the
// project's own real validation so far). API_KEY is required -- job
// creation is an authenticated, state-changing route (see
// docs/security.md) and this script does not weaken that to make
// itself pass.
//
// Exit code 0 = the WebSocket path is verified working. Exit code 1 =
// it is not (with the exact reason printed) -- this script never
// claims success without a real message actually received over the
// real socket.

const WebSocket = require("ws");

const DASHBOARD_URL = (process.env.DASHBOARD_URL || "http://localhost:8080").replace(/\/$/, "");
const API_KEY = process.env.API_KEY;
const TIMEOUT_MS = Number(process.env.WS_VERIFY_TIMEOUT_MS || 15000);

if (!API_KEY) {
  console.error("verify-ws: API_KEY environment variable is required (the real key configured for this deployment).");
  process.exit(1);
}

const wsUrl = DASHBOARD_URL.replace(/^http/, "ws") + "/ws";

function log(msg) {
  console.log(`[verify-ws] ${msg}`);
}

async function main() {
  log(`Connecting to ${wsUrl} ...`);
  const ws = new WebSocket(wsUrl);

  const connectResult = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, reason: "connection timed out" }), TIMEOUT_MS);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve({ ok: true });
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: String(err) });
    });
  });

  if (!connectResult.ok) {
    console.error(`FAIL: could not open WebSocket connection through nginx at ${wsUrl}: ${connectResult.reason}`);
    process.exit(1);
    return;
  }
  log("Connected. Listening for job.updated events...");

  const messages = [];
  ws.on("message", (data) => {
    try {
      const parsed = JSON.parse(data.toString());
      messages.push(parsed);
      log(`Received WS message: ${JSON.stringify(parsed)}`);
    } catch {
      log(`Received non-JSON WS message: ${data.toString()}`);
    }
  });

  // Give the socket a moment to settle, then create a real job through
  // the real public HTTP path (same origin as the WebSocket, through
  // nginx -> api).
  await new Promise((resolve) => setTimeout(resolve, 500));

  log(`Creating a real job via POST ${DASHBOARD_URL}/api/jobs ...`);
  const createRes = await fetch(`${DASHBOARD_URL}/api/jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
    },
    body: JSON.stringify({
      type: "ws-verification",
      payload: { source: "verify-ws.js", createdAt: new Date().toISOString() },
    }),
  });

  if (!createRes.ok) {
    const body = await createRes.text().catch(() => "<unreadable body>");
    console.error(`FAIL: job creation POST returned ${createRes.status}: ${body}`);
    ws.close();
    process.exit(1);
    return;
  }

  const created = await createRes.json();
  const jobId = created.id;
  log(`Job created: id=${jobId}`);

  // Wait for a job.updated event referencing this exact job ID.
  const deadline = Date.now() + TIMEOUT_MS;
  let matched = null;
  while (Date.now() < deadline) {
    matched = messages.find((m) => m.type === "job.updated" && m.jobId === jobId);
    if (matched) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  ws.close();

  if (matched) {
    log(`PASS: received a real job.updated event for job ${jobId} over the WebSocket: ${JSON.stringify(matched)}`);
    log(`Total messages received during this run: ${messages.length}`);
    process.exit(0);
  } else {
    console.error(
      `FAIL: no job.updated event for job ${jobId} was received over the WebSocket within ${TIMEOUT_MS}ms.`
    );
    console.error(`Messages received during this run (${messages.length}): ${JSON.stringify(messages)}`);
    console.error(
      "This means either the change poller / broadcaster isn't reaching this connection, or the job never " +
        "changed state within the timeout -- check `docker compose -f infra/docker-compose.prod.yml logs api worker`."
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`verify-ws: unexpected error: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
