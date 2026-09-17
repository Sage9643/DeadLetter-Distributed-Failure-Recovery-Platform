const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("FAIL: DATABASE_URL environment variable is required.");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

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

async function verifyNormalSubmission() {
  const statusResult = await pool.query(
    `SELECT status, COUNT(*) as count FROM jobs WHERE type = 'load_test_normal' GROUP BY status`
  );
  console.log("Job status breakdown for load_test_normal:");
  console.table(statusResult.rows);

  const totalResult = await pool.query(
    `SELECT COUNT(*) as total FROM jobs WHERE type = 'load_test_normal'`
  );
  const total = Number(totalResult.rows[0].total);

  const completedRow = statusResult.rows.find((r) => r.status === "COMPLETED");
  const completedCount = completedRow ? Number(completedRow.count) : 0;

  console.log(`Total load_test_normal jobs found: ${total}`);
  console.log(`COMPLETED: ${completedCount}`);

  if (total === 0) {
    console.log(
      "FAIL: no load_test_normal jobs found. Either the k6 scenario did not run against this database, or nothing has been submitted yet."
    );
    return false;
  }

  if (completedCount !== total) {
    console.log(
      `FAIL: ${completedCount}/${total} reached COMPLETED. If a worker is running, this may resolve with more time -- re-run this script rather than treating this result as final. If no worker is running against deadletter_load, start one first.`
    );
    return false;
  }

  console.log(`PASS: all ${total} load_test_normal jobs reached COMPLETED.`);
  return true;
}

async function verifyConcurrentSubmission() {
  const statusResult = await pool.query(
    `SELECT status, COUNT(*) as count FROM jobs WHERE type = 'load_test_concurrent' GROUP BY status`
  );
  console.log("Job status breakdown for load_test_concurrent:");
  console.table(statusResult.rows);

  const totalResult = await pool.query(
    `SELECT COUNT(*) as total FROM jobs WHERE type = 'load_test_concurrent'`
  );
  const total = Number(totalResult.rows[0].total);

  const completedRow = statusResult.rows.find((r) => r.status === "COMPLETED");
  const completedCount = completedRow ? Number(completedRow.count) : 0;

  const doubleClaimResult = await pool.query(
    `SELECT COUNT(*) as count FROM jobs WHERE type = 'load_test_concurrent' AND attempt_count > 1`
  );
  const doubleClaimCount = Number(doubleClaimResult.rows[0].count);

  console.log(`Total load_test_concurrent jobs found: ${total}`);
  console.log(`COMPLETED: ${completedCount}`);
  console.log(`Jobs with attempt_count > 1: ${doubleClaimCount}`);

  if (total === 0) {
    console.log(
      "FAIL: no load_test_concurrent jobs found. Either the k6 scenario did not run against this database, or nothing has been submitted yet."
    );
    return false;
  }

  if (completedCount !== total) {
    console.log(
      `FAIL: ${completedCount}/${total} reached COMPLETED. If a worker is running, this may resolve with more time -- re-run this script rather than treating this result as final. If no worker is running against deadletter_load, start one first.`
    );
    return false;
  }

  if (doubleClaimCount !== 0) {
    console.log(
      `FAIL: ${doubleClaimCount} job(s) show attempt_count > 1 under normal (non-failure-injected) concurrent load. This is unexpected and worth investigating before treating the scenario as a clean pass.`
    );
    return false;
  }

  console.log(`PASS: all ${total} load_test_concurrent jobs reached COMPLETED with attempt_count === 1.`);
  return true;
}

// Correctness checks for the retryable-failure scenario. Every
// submitted job carries payload.shouldFail=true (see the existing,
// UNCHANGED stub processor in apps/worker/src/processors/jobProcessor.ts),
// so every job is expected to exhaust the existing, UNCHANGED retry
// policy (calculateBackoffMs, max_attempts=5) and reach DEAD_LETTERED --
// never COMPLETED. This test exercises that existing behavior at real
// HTTP-submitted volume; it does not alter it.
async function verifyFailingSubmission() {
  const statusResult = await pool.query(
    `SELECT status, COUNT(*) as count FROM jobs WHERE type = 'load_test_failing' GROUP BY status`
  );
  console.log("Job status breakdown for load_test_failing:");
  console.table(statusResult.rows);

  const totalResult = await pool.query(
    `SELECT COUNT(*) as total FROM jobs WHERE type = 'load_test_failing'`
  );
  const total = Number(totalResult.rows[0].total);

  const deadLetteredRow = statusResult.rows.find((r) => r.status === "DEAD_LETTERED");
  const deadLetteredCount = deadLetteredRow ? Number(deadLetteredRow.count) : 0;

  console.log(`Total load_test_failing jobs found: ${total}`);
  console.log(`DEAD_LETTERED: ${deadLetteredCount}`);

  if (total === 0) {
    console.log(
      "FAIL: no load_test_failing jobs found. Either the k6 scenario did not run against this database, or nothing has been submitted yet."
    );
    return false;
  }

  if (deadLetteredCount !== total) {
    console.log(
      `FAIL: ${deadLetteredCount}/${total} reached DEAD_LETTERED. Each job must fully exhaust the existing retry policy (backoff 2s/4s/8s/16s, max_attempts=5) before reaching this state -- this takes real time. Re-run this script after waiting rather than treating this result as final. If no worker is running against deadletter_load, start one first.`
    );
    return false;
  }

  // All jobs are DEAD_LETTERED -- now check the SPECIFIC correctness
  // properties this scenario exists to verify: full exhaustion (not a
  // partial retry cycle) and populated dead-letter metadata.
  const wrongAttemptCountResult = await pool.query(
    `SELECT COUNT(*) as count FROM jobs WHERE type = 'load_test_failing' AND attempt_count != max_attempts`
  );
  const wrongAttemptCountCount = Number(wrongAttemptCountResult.rows[0].count);

  const missingReasonResult = await pool.query(
    `SELECT COUNT(*) as count FROM jobs WHERE type = 'load_test_failing' AND last_dead_letter_reason IS NULL`
  );
  const missingReasonCount = Number(missingReasonResult.rows[0].count);

  const missingTimestampResult = await pool.query(
    `SELECT COUNT(*) as count FROM jobs WHERE type = 'load_test_failing' AND last_dead_lettered_at IS NULL`
  );
  const missingTimestampCount = Number(missingTimestampResult.rows[0].count);

  console.log(`Jobs with attempt_count != max_attempts: ${wrongAttemptCountCount}`);
  console.log(`Jobs with NULL last_dead_letter_reason: ${missingReasonCount}`);
  console.log(`Jobs with NULL last_dead_lettered_at: ${missingTimestampCount}`);

  if (wrongAttemptCountCount !== 0) {
    console.log(
      `FAIL: ${wrongAttemptCountCount} job(s) reached DEAD_LETTERED without attempt_count equaling max_attempts -- indicates dead-lettering via the non-retryable path rather than the expected exhaustion path for these deliberately-retryable jobs.`
    );
    return false;
  }

  if (missingReasonCount !== 0) {
    console.log(`FAIL: ${missingReasonCount} job(s) have a NULL last_dead_letter_reason.`);
    return false;
  }

  if (missingTimestampCount !== 0) {
    console.log(`FAIL: ${missingTimestampCount} job(s) have a NULL last_dead_lettered_at.`);
    return false;
  }

  console.log(
    `PASS: all ${total} load_test_failing jobs reached DEAD_LETTERED with full attempt exhaustion and populated dead-letter metadata.`
  );
  return true;
}

async function resetLoadDatabase() {
  console.log("Resetting deadletter_load: TRUNCATE TABLE jobs CASCADE (also clears outbox_events via FK)...");
  await pool.query("TRUNCATE TABLE jobs CASCADE;");
  console.log("Reset complete.");
}

async function main() {
  await assertLoadDatabase();

  const mode = process.argv[2] || "normal";

  if (mode === "reset") {
    await resetLoadDatabase();
    await pool.end();
    console.log("PASS");
    process.exit(0);
    return;
  }

  let passed;
  if (mode === "normal") {
    passed = await verifyNormalSubmission();
  } else if (mode === "concurrent") {
    passed = await verifyConcurrentSubmission();
  } else if (mode === "failing") {
    passed = await verifyFailingSubmission();
  } else {
    console.error(`FAIL: unknown mode "${mode}". Valid modes: normal, concurrent, failing, reset.`);
    await pool.end();
    process.exit(1);
    return;
  }

  await pool.end();

  if (!passed) {
    console.log("FAIL");
    process.exit(1);
  }

  console.log("PASS");
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL: verifyDb.js encountered an error:", err);
  process.exit(1);
});