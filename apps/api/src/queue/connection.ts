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

export async function closeConnection(): Promise<void> {
  await channel?.close();
  await connection?.close();
  channel = null;
  connection = null;
}