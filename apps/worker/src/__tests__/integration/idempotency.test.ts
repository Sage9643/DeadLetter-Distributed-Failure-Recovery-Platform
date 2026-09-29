import { pool } from "../../db/pool";
import { truncateJobs } from "../helpers/testDb";
import { claimJob, markCompleted, getJobById } from "../../services/jobService";

// Phase 16 (Final Finalization Master Prompt -- Correctness Hardening,
// item 2, "Idempotency proof"): a real, Postgres-backed demonstration
// of this project's actual duplicate-delivery safety story, stated
// precisely and without overclaiming:
//
//   1. The transactional outbox (Phase 10) provides DURABLE
//      PUBLICATION INTENT, not exactly-once delivery. If the outbox
//      dispatcher crashes between a successful RabbitMQ publish and
//      committing markOutboxPublished, the row is later reclaimed as
//      stale and published AGAIN -- this is documented, accepted
//      behavior (see docs/engineering-decisions.md,
//      docs/incidents-and-failures.md), not a bug. Duplicate
//      publication of the SAME jobId can therefore genuinely occur.
//   2. What actually prevents duplicate PROCESSING is the worker's
//      atomic conditional claim (claimJob -- a single
//      UPDATE ... WHERE status IN ('QUEUED','RETRYING') ... RETURNING,
//      unchanged since Phase 5): of any number of competing deliveries
//      for the same jobId, PostgreSQL's row-level locking guarantees
//      at most one UPDATE can match and return a row. Every other
//      concurrent delivery's claimJob() call returns null and is
//      acked-without-processing by the consumer (see
//      apps/worker/src/consumer.ts's "Claim failed -- job not in
//      claimable state" branch).
//
// This test simulates two competing deliveries of the SAME jobId --
// exactly what a duplicated outbox publish would hand to two
// concurrent worker message handlers -- and asserts, against REAL
// PostgreSQL (not mocked): only one delivery's claim succeeds, only
// that one delivery's "process the job" side effect actually runs,
// and the job's final state reflects exactly one attempt, not two.
//
// This is NOT a claim of exactly-once delivery -- the message-level
// duplication is real and reproduced here intentionally. It is a
// demonstration that duplicate delivery does not translate into
// duplicate processing.

async function insertJob(overrides: Partial<{ status: string; type: string; attempt_count: number; max_attempts: number }> = {}) {
  const { status = "QUEUED", type = "idempotency_test_job", attempt_count = 0, max_attempts = 5 } = overrides;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO jobs (type, payload, status, attempt_count, max_attempts)
     VALUES ($1, '{}'::jsonb, $2, $3, $4)
     RETURNING id`,
    [type, status, attempt_count, max_attempts]
  );
  const row = result.rows[0];
  if (!row) throw new Error("insertJob: no row returned");
  return row.id;
}

// Stands in for consumer.ts's message handler: attempt the atomic
// claim; if won, run the "side effect" (recorded in sideEffectLog) and
// mark completed; if lost, do nothing -- structurally identical to the
// real handler's claim-then-branch logic, without needing a real
// RabbitMQ message/channel for this test's purpose.
async function simulateDelivery(jobId: string, deliveryLabel: string, sideEffectLog: string[]): Promise<"processed" | "skipped"> {
  const claimed = await claimJob(jobId);
  if (!claimed) {
    return "skipped";
  }
  // The "processJob" side effect -- e.g. sending an email, charging a
  // card, calling a downstream API. Recorded so the test can assert it
  // ran exactly once, which is the property that actually matters for
  // a duplicated delivery (not merely that the DB row looks right).
  sideEffectLog.push(deliveryLabel);
  await markCompleted(jobId);
  return "processed";
}

beforeEach(async () => {
  await truncateJobs();
});

afterAll(async () => {
  await pool.end();
});

describe("duplicate delivery is safe, even though publication is not exactly-once (Phase 16)", () => {
  it("two concurrent deliveries of the SAME jobId: exactly one processes, the side effect runs exactly once", async () => {
    const jobId = await insertJob({ status: "QUEUED" });
    const sideEffectLog: string[] = [];

    // Two competing "deliveries" racing for the same jobId, exactly as
    // a duplicated outbox publish would produce -- fired concurrently,
    // not sequentially, so this is a genuine database-level race, not
    // a simulated one.
    const [outcomeA, outcomeB] = await Promise.all([
      simulateDelivery(jobId, "delivery-A", sideEffectLog),
      simulateDelivery(jobId, "delivery-B", sideEffectLog),
    ]);

    const outcomes = [outcomeA, outcomeB];
    expect(outcomes.filter((o) => o === "processed")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "skipped")).toHaveLength(1);

    // The critical assertion: the side effect -- the thing that would
    // actually be visible/harmful if duplicated (an email sent twice,
    // a charge made twice) -- ran exactly once, not twice.
    expect(sideEffectLog).toHaveLength(1);

    const final = await getJobById(jobId);
    expect(final?.status).toBe("COMPLETED");
    // attempt_count/total_attempt_count both increment only inside the
    // claim that actually won -- the losing delivery's claimJob() call
    // matched zero rows and updated nothing, so both remain 1, not 2,
    // proving the duplicate delivery left no double-counted trace.
    expect(final?.attempt_count).toBe(1);
    expect(final?.total_attempt_count).toBe(1);
  });

  it("three concurrent deliveries of the SAME jobId: still exactly one winner", async () => {
    // A slightly larger fan-in than the minimum needed to prove the
    // point, since a real stale outbox reclaim plus a genuine RabbitMQ
    // redelivery could in principle overlap into more than two
    // in-flight deliveries for the same jobId.
    const jobId = await insertJob({ status: "QUEUED" });
    const sideEffectLog: string[] = [];

    const outcomes = await Promise.all([
      simulateDelivery(jobId, "delivery-A", sideEffectLog),
      simulateDelivery(jobId, "delivery-B", sideEffectLog),
      simulateDelivery(jobId, "delivery-C", sideEffectLog),
    ]);

    expect(outcomes.filter((o) => o === "processed")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "skipped")).toHaveLength(2);
    expect(sideEffectLog).toHaveLength(1);

    const final = await getJobById(jobId);
    expect(final?.status).toBe("COMPLETED");
    expect(final?.attempt_count).toBe(1);
    expect(final?.total_attempt_count).toBe(1);
  });
});
