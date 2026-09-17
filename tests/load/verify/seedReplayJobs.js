const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("FAIL: DATABASE_URL environment variable is required.");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

// Same guard pattern as verifyDb.js -- structurally cannot proceed
// against any database other than deadletter_load.
async function assertLoadDatabase() {
  const result = await pool.query("SELECT current_database()");
  const dbName = result.rows[0].current_database;
  if (dbName !== "deadletter_load") {
    console.error(
      `FAIL: SAFETY ABORT. Connected database is "${dbName}", expected "deadletter_load". Refusing to proceed.`
    );
    process.exit(1);
  }
  console.log(`Safety check passed: connected to "${dbName}"`);
}

// Seeds a fixed, deterministic number of DEAD_LETTERED jobs via DIRECT
// SQL -- deliberately NOT via the real retry pipeline (already proven
// in Scenario C). This isolates "does concurrent replay claiming work
// correctly" from "does the retry pipeline reach DLQ correctly",
// avoiding conflating two different things in one test.
//
// Populates the exact terminal-state fields the real retry pipeline
// would have set (see apps/worker/src/services/jobService.ts's
// markDeadLettered, unmodified): status, attempt_count=max_attempts,
// last_error, last_dead_lettered_at, last_dead_letter_reason.
// replay_count starts at 0, exactly as a freshly-dead-lettered job
// from the real pipeline would have.
const SEED_COUNT = 20;

async function seedReplayJobs() {
  const ids = [];
  for (let i = 0; i < SEED_COUNT; i++) {
    const result = await pool.query(
      `INSERT INTO jobs (
         type, payload, status, attempt_count, max_attempts,
         last_error, last_dead_lettered_at, last_dead_letter_reason
       ) VALUES (
         'load_test_replay', '{}'::jsonb, 'DEAD_LETTERED', 5, 5,
         'seeded directly for Scenario E replay-concurrency test',
         now(), 'seeded directly for Scenario E replay-concurrency test'
       ) RETURNING id`
    );
    ids.push(result.rows[0].id);
  }
  return ids;
}

async function main() {
  await assertLoadDatabase();

  console.log(`Seeding ${SEED_COUNT} DEAD_LETTERED jobs directly via SQL...`);
  const ids = await seedReplayJobs();

  // Verify the seed before writing the file or declaring success --
  // query back what was actually inserted, do not trust the INSERT
  // calls alone.
  const verifyResult = await pool.query(
    `SELECT id, status, attempt_count, max_attempts, replay_count,
            last_dead_lettered_at IS NOT NULL as has_dl_time,
            last_dead_letter_reason IS NOT NULL as has_dl_reason
     FROM jobs WHERE type = 'load_test_replay'`
  );

  const rows = verifyResult.rows;
  const allCorrect = rows.every(
    (r) =>
      r.status === "DEAD_LETTERED" &&
      r.attempt_count === r.max_attempts &&
      Number(r.replay_count) === 0 &&
      r.has_dl_time &&
      r.has_dl_reason
  );

  console.log(`Seeded and verified ${rows.length} rows (expected ${SEED_COUNT}).`);
  console.log(`All rows correctly DEAD_LETTERED with replay_count=0 and populated metadata: ${allCorrect}`);

  await pool.end();

  if (rows.length !== SEED_COUNT || !allCorrect) {
    console.log("FAIL: seed verification failed -- see details above.");
    process.exit(1);
  }

  const outputDir = path.join(__dirname, "..", "k6", "data");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "replay-job-ids.json");
  fs.writeFileSync(outputPath, JSON.stringify(ids, null, 2));

  console.log(`Wrote ${ids.length} real seeded UUIDs to ${outputPath}`);
  console.log("PASS");
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL: seedReplayJobs.js encountered an error:", err);
  process.exit(1);
});