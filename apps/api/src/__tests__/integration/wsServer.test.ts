import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { Broadcaster } from "../../ws/broadcaster";

// Real WebSocket server + real client connection over an ephemeral
// local port. Deliberately does NOT involve the poller or its 2-second
// timer -- broadcaster.broadcast() is called directly, so this test is
// fully deterministic and does not rely on real wall-clock polling.
describe("WebSocket server (real connection)", () => {
  it("delivers a broadcast event to a real connected client", (done) => {
    const server = http.createServer();
    const wss = new WebSocketServer({ server, path: "/ws" });
    const broadcaster = new Broadcaster(wss);

    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const client = new WebSocket(`ws://localhost:${port}/ws`);

      client.on("open", () => {
        broadcaster.broadcast({
          type: "job.updated",
          jobId: "test-job",
          status: "COMPLETED",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });
      });

      client.on("message", (data) => {
        const parsed = JSON.parse(data.toString());
        expect(parsed).toEqual({
          type: "job.updated",
          jobId: "test-job",
          status: "COMPLETED",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });
        client.close();
        wss.close();
        server.close(() => done());
      });
    });
  });
});