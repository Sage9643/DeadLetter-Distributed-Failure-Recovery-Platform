import { WebSocket } from "ws";
import { Broadcaster } from "../../ws/broadcaster";

function makeMockClient(readyState: number) {
  return { readyState, send: jest.fn() } as unknown as WebSocket;
}

describe("Broadcaster", () => {
  it("sends the event only to OPEN clients", () => {
    const openClient = makeMockClient(WebSocket.OPEN);
    const closedClient = makeMockClient(WebSocket.CLOSED);
    const clients = new Set([openClient, closedClient]);
    const broadcaster = new Broadcaster({ clients } as any);

    const event = { type: "job.updated" as const, jobId: "abc", status: "COMPLETED", updatedAt: "2026-01-01T00:00:00.000Z" };
    broadcaster.broadcast(event);

    expect(openClient.send).toHaveBeenCalledWith(JSON.stringify(event));
    expect(closedClient.send).not.toHaveBeenCalled();
  });

  it("does not throw when there are no connected clients", () => {
    const clients = new Set<WebSocket>();
    const broadcaster = new Broadcaster({ clients } as any);
    expect(() =>
      broadcaster.broadcast({ type: "job.updated", jobId: "x", status: "QUEUED", updatedAt: "2026-01-01T00:00:00.000Z" })
    ).not.toThrow();
  });
});