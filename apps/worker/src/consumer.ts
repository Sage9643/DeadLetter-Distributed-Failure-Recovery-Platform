import { getChannel, QUEUE_NAME } from "./queue/connection";
import {
  getJobById,
  markProcessing,
  markCompleted,
  markRetrying,
  markDeadLettered,
} from "./services/jobService";
import { processJob } from "./processors/jobProcessor";
import { NonRetryableError } from "./processors/errors";
import { calculateBackoffMs } from "./retry/retryPolicy";
import { publishRetry, publishDeadLetter } from "./queue/retryPublisher";
import { logger } from "./logger";

interface JobCreatedMessage {
  jobId: string;
}

export async function startConsumer(): Promise<void> {
  const channel = await getChannel();
  await channel.prefetch(1);

  logger.info({ queue: QUEUE_NAME }, "Worker waiting for messages");

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

      let job;
      try {
        job = await getJobById(jobId);

        if (!job) {
          log.warn("Job not found in database, acknowledging and discarding message");
          channel.ack(msg);
          return;
        }

        // Terminal-state guard: prevents redundant reprocessing on redelivery.
        // NOT full idempotency — a plain status check, no locking. Does not
        // protect against a genuine race between two workers processing the
        // same redelivered message concurrently (see Phase 5).
        //
        // RETRYING is deliberately NOT included here — a message redelivered
        // via the retry queue's TTL expiry arrives with status RETRYING and
        // MUST proceed to reprocessing; that is the retry mechanism itself.
        // FAILED is included for backward compatibility with Phase 3 rows,
        // even though the worker no longer writes FAILED as of this phase.
        if (job.status === "COMPLETED" || job.status === "FAILED" || job.status === "DEAD_LETTERED") {
          log.warn({ status: job.status }, "Job already in terminal state, skipping (likely redelivery), acknowledging");
          channel.ack(msg);
          return;
        }

        job = await markProcessing(jobId);
        log.info({ type: job.type, attempt: job.attempt_count, maxAttempts: job.max_attempts }, "Marked job as PROCESSING");
      } catch (dbErr) {
        // Infrastructure failure — nothing was recorded, safe to requeue.
        log.error({ err: dbErr }, "Database error while preparing job for processing; requeueing");
        channel.nack(msg, false, true);
        return;
      }

      try {
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