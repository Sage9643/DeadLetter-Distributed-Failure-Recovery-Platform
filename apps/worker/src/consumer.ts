import { getChannel, QUEUE_NAME } from "./queue/connection";

interface JobCreatedMessage {
  jobId: string;
}

export async function startConsumer(): Promise<void> {
  const channel = await getChannel();

  await channel.prefetch(1);

  console.log(`Worker waiting for messages on ${QUEUE_NAME}...`);

  await channel.consume(
    QUEUE_NAME,
    (msg) => {
      if (!msg) {
        return;
      }

      const content: JobCreatedMessage = JSON.parse(msg.content.toString());
      console.log("Received message:", content);

      channel.ack(msg);
      console.log("Acknowledged message for jobId:", content.jobId);
    },
    { noAck: false }
  );
}