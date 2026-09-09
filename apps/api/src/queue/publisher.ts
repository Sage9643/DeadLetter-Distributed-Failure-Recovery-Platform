import { getChannel, EXCHANGE_NAME, ROUTING_KEY } from "./connection";

export async function publishJobCreated(jobId: string): Promise<void> {
  const channel = await getChannel();

  const message = { jobId };
  const buffer = Buffer.from(JSON.stringify(message));

  const published = channel.publish(EXCHANGE_NAME, ROUTING_KEY, buffer, {
    persistent: true,
  });

  if (!published) {
    throw new Error("Failed to publish job message: channel buffer full or closed");
  }
}