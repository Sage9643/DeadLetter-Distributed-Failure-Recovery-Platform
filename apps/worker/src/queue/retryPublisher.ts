import { getChannel, FAILURES_EXCHANGE_NAME, RETRY_ROUTING_KEY, DLQ_ROUTING_KEY } from "./connection";

export async function publishRetry(jobId: string, delayMs: number): Promise<void> {
  const channel = await getChannel();

  const message = { jobId };
  const buffer = Buffer.from(JSON.stringify(message));

  const published = channel.publish(FAILURES_EXCHANGE_NAME, RETRY_ROUTING_KEY, buffer, {
    persistent: true,
    expiration: String(delayMs),
  });

  if (!published) {
    throw new Error(`Failed to publish retry message for job ${jobId}: channel buffer full or closed`);
  }
}

export async function publishDeadLetter(jobId: string): Promise<void> {
  const channel = await getChannel();

  const message = { jobId };
  const buffer = Buffer.from(JSON.stringify(message));

  const published = channel.publish(FAILURES_EXCHANGE_NAME, DLQ_ROUTING_KEY, buffer, {
    persistent: true,
  });

  if (!published) {
    throw new Error(`Failed to publish dead-letter message for job ${jobId}: channel buffer full or closed`);
  }
}