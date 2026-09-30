// Focused regression test for verify-chaos.js's compose-command
// construction.
//
// This is what actually broke in real production chaos validation:
// `docker compose stop postgres` / `start postgres` / `stop rabbitmq`
// / `start rabbitmq` were run WITHOUT --env-file, so Compose could not
// resolve infra/docker-compose.prod.yml's required interpolated
// variables (POSTGRES_PASSWORD, RABBITMQ_PASSWORD, ...) and every
// command failed before touching any container -- readiness stayed
// {"postgres":"ok","rabbitmq":"ok"} throughout because nothing was
// ever actually stopped.
//
// Uses Node's built-in test runner (node:test / node:assert), same
// convention as scripts/__tests__/extractJobId.test.js. Run with:
//   node --test apps/api/scripts/__tests__/composeCommand.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildComposeCommand } = require("../verify-chaos");

test("buildComposeCommand includes --env-file for a stop command", () => {
  const cmd = buildComposeCommand("infra/docker-compose.prod.yml", "infra/.env.production", "stop postgres");
  assert.equal(cmd, "docker compose -f infra/docker-compose.prod.yml --env-file infra/.env.production stop postgres");
});

test("buildComposeCommand includes --env-file for a start command", () => {
  const cmd = buildComposeCommand("infra/docker-compose.prod.yml", "infra/.env.production", "start rabbitmq");
  assert.equal(cmd, "docker compose -f infra/docker-compose.prod.yml --env-file infra/.env.production start rabbitmq");
});

test("buildComposeCommand applies consistently regardless of which service/args are passed", () => {
  // This is the actual property that matters: every call site in
  // verify-chaos.js (stop postgres, start postgres, stop rabbitmq,
  // start rabbitmq, config --quiet, and the emergency restore path)
  // goes through this one function, so there is nothing left that can
  // fall out of sync and skip --env-file the way the old direct
  // string-templating in compose() did.
  for (const args of ["stop postgres", "start postgres", "stop rabbitmq", "start rabbitmq", "config --quiet"]) {
    const cmd = buildComposeCommand("infra/docker-compose.prod.yml", "infra/.env.production", args);
    assert.ok(cmd.includes("--env-file infra/.env.production"), `expected --env-file in: ${cmd}`);
    assert.ok(cmd.endsWith(args), `expected command to end with '${args}': ${cmd}`);
  }
});

test("buildComposeCommand respects a custom ENV_FILE/COMPOSE_FILE override", () => {
  const cmd = buildComposeCommand("custom-compose.yml", "custom.env", "stop postgres");
  assert.equal(cmd, "docker compose -f custom-compose.yml --env-file custom.env stop postgres");
});
