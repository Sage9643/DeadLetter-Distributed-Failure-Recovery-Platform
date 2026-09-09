import { getChannel, QUEUE_NAME } from "./queue/connection";
import { getJobById, markProcessing, markCompleted, markFailed } from "./services/jobService";
import { processJob } from "./processors/jobProcessor";
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
        if (job.status === "COMPLETED" || job.status === "FAILED") {
          log.warn({ status: job.status }, "Job already in terminal state, skipping (likely redelivery), acknowledging");
          channel.ack(msg);
          return;
        }

        log.info({ type: job.type }, "Marking job as PROCESSING");
        job = await markProcessing(jobId);
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
      } catch (processingErr) {
        // Business-logic failure — record FAILED, then ACK. No retry yet (Phase 4).
        const message = processingErr instanceof Error ? processingErr.message : String(processingErr);
        try {
          await markFailed(jobId, message);
          log.warn({ error: message }, "Job processing failed, marked as FAILED");
        } catch (dbErr) {
          log.error({ err: dbErr }, "Failed to record FAILED status; requeueing");
          channel.nack(msg, false, true);
          return;
        }
      }

      channel.ack(msg);
    },
    { noAck: false }
  );
}