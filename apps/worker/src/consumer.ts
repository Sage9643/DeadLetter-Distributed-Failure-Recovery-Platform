import { getChannel, QUEUE_NAME } from "./queue/connection";
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

export async function startConsumer(): Promise<void> {
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
      try {
        log.info("Attempting atomic claim");
        job = await claimJob(jobId);

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
        channel.nack(msg, false, true);
        return;
      }

      try {
        log.info("Executing processJob() -- this delivery won the claim and is now processing");
        await processJob(job);
        await markCompleted(jobId);
        log.info("Job completed successfully");
        channel.ack(msg);
        return;
      } catch (processingErr) {
        const message = processingErr instanceof Error ? processingErr.message : String(processingErr);
        const nonRetryable = processingErr instanceof NonRetryableError;
        const exhausted = job.attempt_count >= job.max_attempts;

        try {
          if (nonRetryable) {
            await markDeadLettered(jobId, message);
            await publishDeadLetter(jobId);
            log.warn({ error: message, reason: "non-retryable" }, "Job failed permanently, sent to DLQ");
          } else if (exhausted) {
            await markDeadLettered(jobId, message);
            await publishDeadLetter(jobId);
            log.warn(
              { error: message, attempt: job.attempt_count, maxAttempts: job.max_attempts, reason: "attempts-exhausted" },
              "Job failed, max attempts reached, sent to DLQ"
            );
          } else {
            const delayMs = calculateBackoffMs(job.attempt_count);
            await markRetrying(jobId, message);
            await publishRetry(jobId, delayMs);
            log.warn(
              { error: message, attempt: job.attempt_count, maxAttempts: job.max_attempts, delayMs },
              "Job failed, scheduled for retry"
            );
          }
        } catch (dbOrPublishErr) {
          log.error({ err: dbOrPublishErr }, "Failed to record retry/dead-letter outcome; requeueing original message");
          channel.nack(msg, false, true);
          return;
        }

        channel.ack(msg);
      }
    },
    { noAck: false }
  );
}