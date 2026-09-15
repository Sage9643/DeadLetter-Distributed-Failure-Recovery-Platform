import amqp, { ChannelModel, Channel } from "amqplib";
import { env } from "../config/env";

export const EXCHANGE_NAME = "deadletter.jobs.exchange";
export const QUEUE_NAME = "deadletter.jobs.queue";
export const ROUTING_KEY = "job.created";

let connection: ChannelModel | null = null;
let channel: Channel | null = null;

export async function getChannel(): Promise<Channel> {
  if (channel) {
    return channel;
  }

  connection = await amqp.connect(env.RABBITMQ_URL);
  channel = await connection.createChannel();

  await channel.assertExchange(EXCHANGE_NAME, "direct", { durable: true });
  await channel.assertQueue(QUEUE_NAME, { durable: true });
  await channel.bindQueue(QUEUE_NAME, EXCHANGE_NAME, ROUTING_KEY);

  return channel;
}
// Read-only, idempotent AMQP operation against a queue we already
// assert on every getChannel() call. If the cached channel is dead
// (e.g. after a broker restart, per Incident 5), this call fails --
// which is the correct, honest readiness signal. Does not attempt any
// reconnection; that remains a documented, out-of-scope limitation.
export async function checkRabbitMQHealth(): Promise<void> {
  const ch = await getChannel();
  await ch.checkQueue(QUEUE_NAME);
}
export async function closeConnection(): Promise<void> {
  await channel?.close();
  await connection?.close();
  channel = null;
  connection = null;
}