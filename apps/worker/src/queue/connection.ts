import amqp, { ChannelModel, Channel } from "amqplib";
import { EventEmitter } from "events";
import { env } from "../config/env";
import { logger } from "../logger";

export const EXCHANGE_NAME = "deadletter.jobs.exchange";
export const QUEUE_NAME = "deadletter.jobs.queue";
export const ROUTING_KEY = "job.created";

// Phase 4: failure-routing topology (retry + dead-letter)
export const FAILURES_EXCHANGE_NAME = "deadletter.jobs.failures.exchange";
export const RETRY_QUEUE_NAME = "deadletter.jobs.retry.queue";
export const RETRY_ROUTING_KEY = "job.retry";
export const DLQ_QUEUE_NAME = "deadletter.jobs.dlq";
export const DLQ_ROUTING_KEY = "job.dead_letter";

// Phase 14: resolves Incident 5/8 (see incidents-and-failures.md).
// Emits "invalidated" whenever the cached connection/channel is torn
// down by something OTHER than an intentional closeConnection() call.
// Unlike the API side, the worker holds a long-lived channel.consume()
// subscription -- reconnecting getChannel() alone is not enough,
// because nothing re-attaches the subscription to the new channel on
// its own. consumer.ts listens for this event and resubscribes with
// backoff. See consumer.ts for that side of the fix.
export const connectionEvents = new EventEmitter();

let connection: ChannelModel | null = null;
let channel: Channel | null = null;
// Set for the duration of an explicit closeConnection() call so the
// "close" events that call itself triggers don't also fire
// "invalidated" -- index.ts's clean SIGTERM/SIGINT shutdown must not
// be mistaken for a failure and trigger a reconnect/resubscribe loop
// moments before process.exit().
let closingIntentionally = false;

export async function getChannel(): Promise<Channel> {
  if (channel) {
    return channel;
  }

  closingIntentionally = false;

  const newConnection = await amqp.connect(env.RABBITMQ_URL);
  const newChannel = await newConnection.createChannel();

  // Phase 14: identity checks guard against a stale event from an
  // already-replaced connection/channel clobbering a newer, healthy
  // one -- see apps/api/src/queue/connection.ts for the same pattern
  // and its full rationale.
  const invalidate = (reason: string, err?: unknown) => {
    if (connection !== newConnection && channel !== newChannel) return;
    if (closingIntentionally) return;
    logger.warn({ err }, `RabbitMQ ${reason}; invalidating cached connection/channel`);
    if (connection === newConnection) connection = null;
    if (channel === newChannel) channel = null;
    connectionEvents.emit("invalidated");
  };

  newConnection.on("error", (err) => invalidate("connection error", err));
  newConnection.on("close", () => invalidate("connection closed"));
  newChannel.on("error", (err) => invalidate("channel error", err));
  newChannel.on("close", () => invalidate("channel closed"));

  // Main processing topology (unchanged since Phase 2)
  await newChannel.assertExchange(EXCHANGE_NAME, "direct", { durable: true });
  await newChannel.assertQueue(QUEUE_NAME, { durable: true });
  await newChannel.bindQueue(QUEUE_NAME, EXCHANGE_NAME, ROUTING_KEY);

  // Phase 4: failures exchange, routes to either retry or DLQ
  await newChannel.assertExchange(FAILURES_EXCHANGE_NAME, "direct", { durable: true });

  // Retry queue: no queue-level TTL. Per-message TTL (expiration) is set
  // at publish time based on calculated backoff. On expiry, RabbitMQ
  // dead-letters the message back into the main exchange/queue — this
  // native TTL+DLX behavior IS the delay/retry mechanism, no plugin needed.
  await newChannel.assertQueue(RETRY_QUEUE_NAME, {
    durable: true,
    arguments: {
      "x-dead-letter-exchange": EXCHANGE_NAME,
      "x-dead-letter-routing-key": ROUTING_KEY,
    },
  });
  await newChannel.bindQueue(RETRY_QUEUE_NAME, FAILURES_EXCHANGE_NAME, RETRY_ROUTING_KEY);

  // Dead letter queue: final resting place for exhausted/non-retryable jobs.
  // Not consumed this phase — inspection/replay is later work.
  await newChannel.assertQueue(DLQ_QUEUE_NAME, { durable: true });
  await newChannel.bindQueue(DLQ_QUEUE_NAME, FAILURES_EXCHANGE_NAME, DLQ_ROUTING_KEY);

  connection = newConnection;
  channel = newChannel;

  return channel;
}

export async function closeConnection(): Promise<void> {
  closingIntentionally = true;
  await channel?.close();
  await connection?.close();
  channel = null;
  connection = null;
}
