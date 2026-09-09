import amqp, { ChannelModel, Channel } from "amqplib";
import { env } from "../config/env";

export const EXCHANGE_NAME = "deadletter.jobs.exchange";
export const QUEUE_NAME = "deadletter.jobs.queue";
export const ROUTING_KEY = "job.created";

// Phase 4: failure-routing topology (retry + dead-letter)
export const FAILURES_EXCHANGE_NAME = "deadletter.jobs.failures.exchange";
export const RETRY_QUEUE_NAME = "deadletter.jobs.retry.queue";
export const RETRY_ROUTING_KEY = "job.retry";
export const DLQ_QUEUE_NAME = "deadletter.jobs.dlq";
export const DLQ_ROUTING_KEY = "job.dead_letter";

let connection: ChannelModel | null = null;
let channel: Channel | null = null;

export async function getChannel(): Promise<Channel> {
  if (channel) {
    return channel;
  }

  connection = await amqp.connect(env.RABBITMQ_URL);
  channel = await connection.createChannel();

  // Main processing topology (unchanged since Phase 2)
  await channel.assertExchange(EXCHANGE_NAME, "direct", { durable: true });
  await channel.assertQueue(QUEUE_NAME, { durable: true });
  await channel.bindQueue(QUEUE_NAME, EXCHANGE_NAME, ROUTING_KEY);

  // Phase 4: failures exchange, routes to either retry or DLQ
  await channel.assertExchange(FAILURES_EXCHANGE_NAME, "direct", { durable: true });

  // Retry queue: no queue-level TTL. Per-message TTL (expiration) is set
  // at publish time based on calculated backoff. On expiry, RabbitMQ
  // dead-letters the message back into the main exchange/queue — this
  // native TTL+DLX behavior IS the delay/retry mechanism, no plugin needed.
  await channel.assertQueue(RETRY_QUEUE_NAME, {
    durable: true,
    arguments: {
      "x-dead-letter-exchange": EXCHANGE_NAME,
      "x-dead-letter-routing-key": ROUTING_KEY,
    },
  });
  await channel.bindQueue(RETRY_QUEUE_NAME, FAILURES_EXCHANGE_NAME, RETRY_ROUTING_KEY);

  // Dead letter queue: final resting place for exhausted/non-retryable jobs.
  // Not consumed this phase — inspection/replay is later work.
  await channel.assertQueue(DLQ_QUEUE_NAME, { durable: true });
  await channel.bindQueue(DLQ_QUEUE_NAME, FAILURES_EXCHANGE_NAME, DLQ_ROUTING_KEY);

  return channel;
}

export async function closeConnection(): Promise<void> {
  await channel?.close();
  await connection?.close();
  channel = null;
  connection = null;
}