import { EventEmitter } from "events";

// Phase 14 (resolves Incident 5/8 -- see docs/incidents-and-failures.md,
// which recorded: "the worker's consumer did NOT self-recover in
// either [real chaos-test] execution and required a restart both
// times"). This test proves, deterministically and without a real
// broker, that the worker now resubscribes on its own after the
// channel it was consuming from dies -- see
// apps/api/src/__tests__/unit/connectionRecovery.test.ts for the full
// rationale on mocking amqplib here rather than a real broker. This
// does not replace a real chaos test against an actual RabbitMQ
// outage; that remains the authoritative end-to-end evidence and has
// not yet been re-run against this fix (see development-log.md,
// Phase 14).

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

// Phase 14 test-sync fix: the real resubscribe path inside
// getChannel() awaits a chain of 8+ topology calls (assertExchange /
// assertQueue / bindQueue for the main, retry and DLQ topology) plus
// prefetch() and consume() before a reconnect is actually observable.
// How many microtask ticks that chain takes is an implementation
// detail of getChannel()'s topology setup, not something this test
// should hardcode or guess at -- counting a fixed number of
// `await Promise.resolve()` calls is exactly the kind of brittle
// synchronization that produced the original
// "Expected number of calls: 1, Received number of calls: 0" failure
// (the real chain simply hadn't finished by the time the fixed tick
// count ran out). Polling on a real timer instead lets Node actually
// drain the microtask queue between checks and waits for the SAME
// observable outcome the test already asserted on -- consume() having
// actually been called on the new channel -- without weakening the
// assertion and without any single arbitrary/long sleep.
async function waitForCondition(
  predicate: () => boolean,
  { timeoutMs = 2000, intervalMs = 5 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("waitForCondition: timed out waiting for condition to become true");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe("apps/worker consumer -- Incident 5/8 resubscribe after disconnect", () => {
  beforeEach(() => {
    jest.resetModules();
    connectMock.mockReset();
  });

  it("resubscribes automatically after the channel is invalidated, without a process restart", async () => {
    const connections: FakeConnection[] = [];
    connectMock.mockImplementation(async () => {
      const conn = new FakeConnection();
      connections.push(conn);
      return conn;
    });

    const { startConsumer } = await import("../../consumer");

    await startConsumer();
    expect(connections).toHaveLength(1);
    expect(connections[0]!.channels[0]!.consume).toHaveBeenCalledTimes(1);

    connections[0]!.channels[0]!.emit("close");

    // Wait for the actual resubscription to complete -- a second
    // connection to exist and its channel's consume() to have
    // genuinely been called -- instead of guessing how many microtask
    // ticks resubscribeWithBackoff()'s real async chain needs.
    await waitForCondition(
      () =>
        connections.length === 2 &&
        connections[1]!.channels.length === 1 &&
        connections[1]!.channels[0]!.consume.mock.calls.length === 1
    );

    expect(connections).toHaveLength(2);
    expect(connections[1]!.channels[0]!.consume).toHaveBeenCalledTimes(1);
  });

  it("retries after a failed resubscribe attempt and eventually succeeds, without a process restart", async () => {
    jest.useFakeTimers();
    try {
      const connections: FakeConnection[] = [];
      let connectCallCount = 0;
      connectMock.mockImplementation(async () => {
        connectCallCount += 1;
        if (connectCallCount === 2) {
          // The first RECONNECT attempt (the 2nd connect() call overall,
          // after the successful initial boot connect) fails.
          throw new Error("simulated: broker still unreachable");
        }
        const conn = new FakeConnection();
        connections.push(conn);
        return conn;
      });

      const { startConsumer } = await import("../../consumer");
      await startConsumer();
      expect(connections).toHaveLength(1);

      connections[0]!.channels[0]!.emit("close");

      // Let the first (failing) reconnect attempt's microtasks run.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Advance well past the backoff delay so the second reconnect
      // attempt (which succeeds) actually runs.
      await jest.advanceTimersByTimeAsync(5000);

      expect(connectCallCount).toBeGreaterThanOrEqual(3);
      expect(connections).toHaveLength(2);
      expect(connections[1]!.channels[0]!.consume).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
