import { getChannel, QUEUE_NAME, connectionEvents } from "./queue/connection";
import {
  getJobById,
  claimJob,
  markCompleted,
  markRetrying,
  markDeadLettered,
} from "./services/jobService";
import { processJob } from "./processors/jobProcessor";
import { NonRetryableError } from "./processors/errors";
import { calculateBackoffMs } from "./retry/retryPolicy";
import { publishRetry, publishDeadLetter } from "./queue/retryPublisher";
import { logger } from "./logger";
import { env } from "./config/env";

interface JobCreatedMessage {
  jobId: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Postgres error code 22P02 = invalid_text_representation, e.g. a
// jobId string that is not valid UUID syntax. This indicates a
// permanently malformed message, not a transient infrastructure
// failure -- requeueing it would loop forever since the error can
// never resolve on retry.
function isInvalidTextRepresentationError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "22P02";
}

const DB_ERROR_BASE_DELAY_MS = 1000;
const DB_ERROR_MAX_DELAY_MS = 30000;

let dbErrorCount = 0;

// Phase 15: resolves the "NACK+requeue on DB/publish errors has no
// backoff -- could hot-loop under a sustained outage" limitation
// tracked since Phase 4 (see failure-handling.md and
// engineering-decisions.md, Phase 15). Pure function, exported for
// direct unit testing: computes the delay for the Nth CONSECUTIVE
// DB/infrastructure error (1-indexed -- the 1st error uses the base
// delay, doubling thereafter, capped).
export function computeDbErrorBackoffMs(consecutiveErrors: number): number {
  return Math.min(DB_ERROR_BASE_DELAY_MS * 2 ** (consecutiveErrors - 1), DB_ERROR_MAX_DELAY_MS);
}

// Sleeps for the current consecutive-DB-error backoff BEFORE the
// caller NACKs-and-requeues, so a sustained Postgres/infrastructure
// outage throttles this worker's redelivery rate instead of retrying
// as fast as RabbitMQ and the network allow. Deliberately local,
// in-process state only -- no DB write records dbErrorCount (the DB
// may be the thing that is down), and deliberately kept separate from
// retryPolicy.ts's job-level retry backoff (a different concern:
// infrastructure liveness, not job-processing retry tuning -- the same
// separation Phase 14 used for resubscribeWithBackoff vs.
// calculateBackoffMs). Reset to 0 by the caller after any claimJob()
// call that does not throw, so an isolated blip does not inflate the
// delay applied to later, unrelated messages.
async function backoffBeforeRequeue(): Promise<void> {
  dbErrorCount += 1;
  const delayMs = computeDbErrorBackoffMs(dbErrorCount);
  logger.warn(
    { dbErrorCount, delayMs },
    "Worker requeueing after DB/infrastructure error; backing off before next delivery"
  );
  await sleep(delayMs);
}

// Phase 14: attaches prefetch + the message handler to whatever
// channel getChannel() currently returns. Called once at startup and
// again, automatically, every time the cached channel is invalidated
// (broker restart, network drop -- see queue/connection.ts and
// docs/incidents-and-failures.md, Incident 5/8). Extracted out of
// startConsumer() so the first connect and every later reconnect share
// the exact same handler -- no duplicated or drifted logic between the
// two call sites.
async function subscribe(): Promise<void> {
  const channel = await getChannel();
  await channel.prefetch(1);

  logger.info({ queue: QUEUE_NAME }, "Worker waiting for messages");

  if (env.CLAIM_TEST_SYNC_EPOCH_MS > 0) {
    logger.warn(
      {
        targetEpochMs: env.CLAIM_TEST_SYNC_EPOCH_MS,
        targetIso: new Date(env.CLAIM_TEST_SYNC_EPOCH_MS).toISOString(),
      },
      "CLAIM_TEST_SYNC_EPOCH_MS is set -- TEST-ONLY claim synchronization active. Do not use in production."
    );
  }

  await channel.consume(
    QUEUE_NAME,
    async (msg) => {
      if (!msg) return;

      let content: JobCreatedMessage;
      try {
        content = JSON.parse(msg.content.toString());
      } catch (err) {
        logger.error({ err }, "Malformed message payload, acknowledging and discarding");
        channel.ack(msg);
        return;
      }

      const { jobId } = content;
      const log = logger.child({ jobId });

      // TEST-ONLY: sleep until a shared absolute target time so that
      // multiple independent worker processes converge their claim
      // attempts to (near) the same instant, regardless of when each
      // actually received its message. This is what makes the
      // concurrent-claim test (Test 4) a genuine race rather than a
      // sequential-but-close-in-time check. Disabled (0) by default.
      if (env.CLAIM_TEST_SYNC_EPOCH_MS > 0) {
        const waitMs = env.CLAIM_TEST_SYNC_EPOCH_MS - Date.now();
        if (waitMs > 0) {
          log.warn({ waitMs, targetEpochMs: env.CLAIM_TEST_SYNC_EPOCH_MS }, "Sleeping until synchronized claim-test target time");
          await sleep(waitMs);
        } else {
          log.warn(
            { missedByMs: -waitMs, targetEpochMs: env.CLAIM_TEST_SYNC_EPOCH_MS },
            "Claim-test target time already passed -- proceeding immediately without synchronization"
          );
        }
      }

      let job;
      let claimedAt = 0;
      try {
        log.info("Attempting atomic claim");
        job = await claimJob(jobId);
        dbErrorCount = 0; // Phase 15: claimJob() did not throw -- reset the backoff counter

        if (!job) {
          // Claim failed: not in a claimable state at the moment of the
          // atomic UPDATE. Covers ALL of: lost a concurrent-claim race
          // (the case this phase exists to handle), already terminal,
          // or does not exist. The decision was already made atomically
          // by the UPDATE itself -- this follow-up read is for logging
          // context only and has no bearing on correctness.
          const current = await getJobById(jobId).catch(() => null);
          log.warn(
            { currentStatus: current?.status ?? "unknown" },
            "Claim failed -- job not in claimable state (lost race, already terminal, or not found). Acknowledging without processing."
          );
          channel.ack(msg);
          return;
        }

        claimedAt = Date.now();
        log.info(
          { type: job.type, attempt: job.attempt_count, maxAttempts: job.max_attempts },
          "Claimed job, marked PROCESSING"
        );
      } catch (dbErr) {
        if (isInvalidTextRepresentationError(dbErr)) {
          log.error({ err: dbErr }, "Malformed jobId (invalid UUID), acknowledging and discarding -- will not requeue");
          channel.ack(msg);
          return;
        }

        // Genuine infrastructure failure (e.g. DB unreachable) -- nothing
        // was recorded, safe to requeue.
        log.error({ err: dbErr }, "Database error while claiming job; requeueing");
        await backoffBeforeRequeue(); // Phase 15
        channel.nack(msg, false, true);
        return;
      }

      try {
        log.info("Executing processJob() -- this delivery won the claim and is now processing");
        await processJob(job);
        await markCompleted(jobId);
        const durationMs = Date.now() - claimedAt;
        log.info({ durationMs }, "Job completed successfully");
        channel.ack(msg);
        return;
      } catch (processingErr) {
        const message = processingErr instanceof Error ? processingErr.message : String(processingErr);
        const nonRetryable = processingErr instanceof NonRetryableError;
        const exhausted = job.attempt_count >= job.max_attempts;
        const durationMs = Date.now() - claimedAt;

        try {
          if (nonRetryable) {
            await markDeadLettered(jobId, message);
            await publishDeadLetter(jobId);
            log.warn({ error: message, reason: "non-retryable", durationMs }, "Job failed permanently, sent to DLQ");
          } else if (exhausted) {
            await markDeadLettered(jobId, message);
            await publishDeadLetter(jobId);
            log.warn(
              { error: message, attempt: job.attempt_count, maxAttempts: job.max_attempts, reason: "attempts-exhausted", durationMs },
              "Job failed, max attempts reached, sent to DLQ"
            );
          } else {
            const delayMs = calculateBackoffMs(job.attempt_count);
            await markRetrying(jobId, message);
            await publishRetry(jobId, delayMs);
            log.warn(
              { error: message, attempt: job.attempt_count, maxAttempts: job.max_attempts, delayMs, durationMs },
              "Job failed, scheduled for retry"
            );
          }
        } catch (dbOrPublishErr) {
          log.error({ err: dbOrPublishErr }, "Failed to record retry/dead-letter outcome; requeueing original message");
          await backoffBeforeRequeue(); // Phase 15
          channel.nack(msg, false, true);
          return;
        }

        channel.ack(msg);
      }
    },
    { noAck: false }
  );
}

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;

let reconnecting = false;

// Phase 14: resolves Incident 5/8's worker-side finding ("the worker's
// consumer did NOT self-recover in either [chaos test] execution and
// required a restart both times"). Triggered by connection.ts's
// "invalidated" event -- never by an intentional shutdown, since
// closeConnection() suppresses that event (see connection.ts). Capped
// exponential backoff, reusing the same doubling-with-ceiling shape as
// the job-level retry policy but implemented separately and locally:
// this is a connection-liveness concern, not a job-processing concern,
// and conflating the two would tie unrelated semantics together for no
// real benefit. Guarded by `reconnecting` so overlapping "invalidated"
// events (a channel closing as a direct consequence of its connection
// closing fires both) trigger exactly one retry loop, not two racing
// ones.
async function resubscribeWithBackoff(): Promise<void> {
  if (reconnecting) return;
  reconnecting = true;
  let delayMs = RECONNECT_BASE_DELAY_MS;

  try {
    while (true) {
      try {
        await subscribe();
        logger.info("Worker RabbitMQ consumer resubscribed after disconnect");
        return;
      } catch (err) {
        logger.error({ err, nextRetryMs: delayMs }, "Worker failed to resubscribe to RabbitMQ; retrying");
        await sleep(delayMs);
        delayMs = Math.min(delayMs * 2, RECONNECT_MAX_DELAY_MS);
      }
    }
  } finally {
    reconnecting = false;
  }
}

connectionEvents.on("invalidated", () => {
  void resubscribeWithBackoff();
});

export async function startConsumer(): Promise<void> {
  await subscribe();
}
