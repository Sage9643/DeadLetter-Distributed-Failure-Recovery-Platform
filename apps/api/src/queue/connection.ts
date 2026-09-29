import amqp, { ChannelModel, Channel } from "amqplib";
import { EventEmitter } from "events";
import { env } from "../config/env";
import { logger } from "../logger";

export const EXCHANGE_NAME = "deadletter.jobs.exchange";
export const QUEUE_NAME = "deadletter.jobs.queue";
export const ROUTING_KEY = "job.created";

// Phase 14: resolves Incident 5/8 (see incidents-and-failures.md).
// Emits "invalidated" whenever the cached connection/channel is torn
// down by something OTHER than an intentional closeConnection() call
// -- a broker restart, a network drop, a forced connection closure.
// This dispatcher only ever calls getChannel() on demand (its own 2s
// poll loop), so it needs no listener here at all: once the cache is
// null, the next getChannel() call reconnects naturally. This emitter
// exists for callers that hold a long-lived subscription instead (the
// worker's consumer) and must actively resubscribe after a disconnect
// -- see apps/worker/src/consumer.ts.
export const connectionEvents = new EventEmitter();

let connection: ChannelModel | null = null;
let channel: Channel | null = null;
// Set for the duration of an explicit closeConnection() call so the
// "close" events that call itself triggers on connection/channel don't
// also fire "invalidated" -- an intentional shutdown must not look
// like a failure to any caller reacting to that event.
let closingIntentionally = false;

export async function getChannel(): Promise<Channel> {
  if (channel) {
    return channel;
  }

  closingIntentionally = false;

  const newConnection = await amqp.connect(env.RABBITMQ_URL);
  const newChannel = await newConnection.createChannel();

  // Phase 14: without this, a dead connection/channel stays cached
  // forever -- getChannel() keeps returning a closed object and every
  // publish keeps failing, exactly as observed in Incident 5/8's first
  // execution. The identity checks below guard against a stale event
  // from an already-replaced connection/channel clobbering a newer,
  // healthy one (possible because amqplib's own "close"/"error"
  // delivery is asynchronous relative to a subsequent getChannel()
  // call already having reconnected).
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

  await newChannel.assertExchange(EXCHANGE_NAME, "direct", { durable: true });
  await newChannel.assertQueue(QUEUE_NAME, { durable: true });
  await newChannel.bindQueue(QUEUE_NAME, EXCHANGE_NAME, ROUTING_KEY);

  connection = newConnection;
  channel = newChannel;

  return channel;
}
// Read-only, idempotent AMQP operation against a queue we already
// assert on every getChannel() call. If the cached channel is dead,
// getChannel() itself now reconnects (Phase 14) before this runs, so
// this check reflects a genuine, current liveness probe rather than a
// permanently stale readiness signal.
export async function checkRabbitMQHealth(): Promise<void> {
  const ch = await getChannel();
  await ch.checkQueue(QUEUE_NAME);
}
export async function closeConnection(): Promise<void> {
  closingIntentionally = true;
  await channel?.close();
  await connection?.close();
  channel = null;
  connection = null;
}
