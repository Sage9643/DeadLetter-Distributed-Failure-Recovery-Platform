import { getChannel, closeConnection } from "./connection";

async function main() {
  await getChannel();
  console.log("Worker connected to RabbitMQ and topology confirmed.");
  await closeConnection();
}

main().catch((err) => {
  console.error("Failed to connect:", err);
  process.exit(1);
});