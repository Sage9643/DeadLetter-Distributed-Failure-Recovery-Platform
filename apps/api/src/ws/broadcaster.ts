import { WebSocket, WebSocketServer } from "ws";
import { logger } from "../logger";

export interface JobUpdatedEvent {
  type: "job.updated";
  jobId: string;
  status: string;
  updatedAt: string;
}

// Thin wrapper around a WebSocketServer's client set. Deliberately
// separated from the poller and the HTTP/WS bootstrap so it can be unit
// tested against plain mock socket objects, independent of a real
// network connection, a real Postgres query, or a real timer.
export class Broadcaster {
  constructor(private readonly wss: Pick<WebSocketServer, "clients">) {}

  broadcast(event: JobUpdatedEvent): void {
    const payload = JSON.stringify(event);
    let sent = 0;
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
        sent += 1;
      }
    });
    logger.debug({ event, sent }, "Broadcast job.updated event");
  }
}