import { EventEmitter } from "events";

// Phase 14 (resolves Incident 5/8 -- see docs/incidents-and-failures.md).
// amqplib is mocked here because the exact "connection/channel just
// died" event sequence Incident 5 depends on cannot be reliably
// triggered against a real, healthy broker inside a Jest run -- there
// is no way to force a genuine RabbitMQ outage from inside a unit
// test. This proves the cache-invalidation/reconnection LOGIC
// deterministically. It does not replace a real chaos test against an
// actual RabbitMQ outage (see docs/load-testing.md) -- that remains
// the authoritative end-to-end evidence and has not yet been re-run
// against this fix (see development-log.md, Phase 14).

class FakeChannel extends EventEmitter {
  assertExchange = jest.fn().mockResolvedValue(undefined);
  assertQueue = jest.fn().mockResolvedValue(undefined);
  bindQueue = jest.fn().mockResolvedValue(undefined);
  checkQueue = jest.fn().mockResolvedValue(undefined);
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

// Defensive double-shape: covers both `require("amqplib").connect(...)`
// and `require("amqplib").default.connect(...)`, since this project's
// tsconfig does not set esModuleInterop and this test cannot be run
// from this authoring environment to observe which shape ts-jest's
// commonjs output actually needs at runtime.
jest.mock("amqplib", () => {
  const connect = (...args: unknown[]) => connectMock(...args);
  return { connect, default: { connect } };
});

describe("apps/api queue/connection -- Incident 5/8 reconnection", () => {
  beforeEach(() => {
    jest.resetModules();
    connectMock.mockReset();
  });

  it("reconnects automatically once the cached channel closes, instead of returning a dead channel forever", async () => {
    const connections: FakeConnection[] = [];
    connectMock.mockImplementation(async () => {
      const conn = new FakeConnection();
      connections.push(conn);
      return conn;
    });

    const { getChannel } = await import("../../queue/connection");

    const channel1 = await getChannel();
    const channel2 = await getChannel();
    expect(channel2).toBe(channel1);
    expect(connectMock).toHaveBeenCalledTimes(1);

    // Simulate exactly what Incident 5 observed: the broker connection
    // drops out from under an already-cached, in-use channel.
    connections[0]!.channels[0]!.emit("close");

    const channel3 = await getChannel();
    expect(channel3).not.toBe(channel1);
    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it("reconnects on a connection-level error event too, not only a channel close", async () => {
    const connections: FakeConnection[] = [];
    connectMock.mockImplementation(async () => {
      const conn = new FakeConnection();
      connections.push(conn);
      return conn;
    });

    const { getChannel } = await import("../../queue/connection");
    await getChannel();

    connections[0]!.emit("error", new Error("simulated broker-forced connection closure"));

    await getChannel();
    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT emit 'invalidated' or trigger a reconnect on an intentional closeConnection() call", async () => {
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

  it("ignores a stale close event from an already-replaced connection", async () => {
    const connections: FakeConnection[] = [];
    connectMock.mockImplementation(async () => {
      const conn = new FakeConnection();
      connections.push(conn);
      return conn;
    });

    const { getChannel } = await import("../../queue/connection");

    await getChannel(); // connections[0]
    connections[0]!.channels[0]!.emit("close"); // invalidates it
    const channel2 = await getChannel(); // connections[1], the new healthy one

    // A late-arriving close event from the OLD, already-replaced
    // connection/channel must not clobber the new, healthy one.
    connections[0]!.channels[0]!.emit("close");

    const channel3 = await getChannel();
    expect(channel3).toBe(channel2);
    expect(connectMock).toHaveBeenCalledTimes(2);
  });
});
