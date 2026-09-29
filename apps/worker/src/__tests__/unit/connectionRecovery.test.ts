import { EventEmitter } from "events";

// Phase 14 (resolves Incident 5/8 -- see docs/incidents-and-failures.md).
// See apps/api/src/__tests__/unit/connectionRecovery.test.ts for the
// full rationale on why amqplib is mocked here rather than exercised
// against a real broker -- the same applies on the worker side.

class FakeChannel extends EventEmitter {
  assertExchange = jest.fn().mockResolvedValue(undefined);
  assertQueue = jest.fn().mockResolvedValue(undefined);
  bindQueue = jest.fn().mockResolvedValue(undefined);
  prefetch = jest.fn().mockResolvedValue(undefined);
  consume = jest.fn().mockResolvedValue({ consumerTag: "fake-consumer" });
  close = jest.fn().mockResolvedValue(undefined);
}

class FakeConnection extends EventEmitter {
  channels: FakeChannel[] = [];
  createChannel = jest.fn().mockImplementation(async () => {
    const ch = new FakeChannel();
    this.channels.push(ch);
    return ch;
  });
  close = jest.fn().mockResolvedValue(undefined);
}

const connectMock = jest.fn();

jest.mock("amqplib", () => {
  const connect = (...args: unknown[]) => connectMock(...args);
  return { connect, default: { connect } };
});

describe("apps/worker queue/connection -- Incident 5/8 reconnection", () => {
  beforeEach(() => {
    jest.resetModules();
    connectMock.mockReset();
  });

  it("reconnects automatically once the cached channel closes", async () => {
    const connections: FakeConnection[] = [];
    connectMock.mockImplementation(async () => {
      const conn = new FakeConnection();
      connections.push(conn);
      return conn;
    });

    const { getChannel } = await import("../../queue/connection");

    const channel1 = await getChannel();
    expect(connectMock).toHaveBeenCalledTimes(1);

    connections[0]!.channels[0]!.emit("close");

    const channel2 = await getChannel();
    expect(channel2).not.toBe(channel1);
    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT emit 'invalidated' on an intentional closeConnection() call", async () => {
    const connections: FakeConnection[] = [];
    connectMock.mockImplementation(async () => {
      const conn = new FakeConnection();
      connections.push(conn);
      return conn;
    });

    const { getChannel, closeConnection, connectionEvents } = await import("../../queue/connection");
    const invalidatedSpy = jest.fn();
    connectionEvents.on("invalidated", invalidatedSpy);

    await getChannel();
    await closeConnection();

    expect(invalidatedSpy).not.toHaveBeenCalled();
    connectionEvents.off("invalidated", invalidatedSpy);
  });
});
