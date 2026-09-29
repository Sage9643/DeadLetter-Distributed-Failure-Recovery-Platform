import { EventEmitter } from "events";

// Phase 15 (resolves the "NACK+requeue on DB/publish errors has no
// backoff -- could hot-loop under a sustained outage" limitation
// tracked since Phase 4 -- see docs/failure-handling.md and
// docs/engineering-decisions.md). Mocks amqplib (same pattern as
// Phase 14's connectionRecovery/consumerResubscribe tests) AND
// services/jobService, processors/jobProcessor, queue/retryPublisher,
// so each DB-error and business-failure branch of the message handler
// can be driven deterministically without a real Postgres or
// RabbitMQ. This does not replace the real chaos test against an
// actual sustained Postgres outage (see docs/load-testing.md /
// docs/development-log.md, Phase 15) -- it proves the backoff LOGIC is
// internally correct.

class FakeChannel extends EventEmitter {
  assertExchange = jest.fn().mockResolvedValue(undefined);
  assertQueue = jest.fn().mockResolvedValue(undefined);
  bindQueue = jest.fn().mockResolvedValue(undefined);
  prefetch = jest.fn().mockResolvedValue(undefined);
  consume = jest.fn().mockResolvedValue({ consumerTag: "fake-consumer" });
  ack = jest.fn();
  nack = jest.fn();
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

const claimJobMock = jest.fn();
const getJobByIdMock = jest.fn();
const markCompletedMock = jest.fn();
const markRetryingMock = jest.fn();
const markDeadLetteredMock = jest.fn();

jest.mock("../../services/jobService", () => ({
  claimJob: (...args: unknown[]) => claimJobMock(...args),
  getJobById: (...args: unknown[]) => getJobByIdMock(...args),
  markCompleted: (...args: unknown[]) => markCompletedMock(...args),
  markRetrying: (...args: unknown[]) => markRetryingMock(...args),
  markDeadLettered: (...args: unknown[]) => markDeadLetteredMock(...args),
}));

const processJobMock = jest.fn();
jest.mock("../../processors/jobProcessor", () => ({
  processJob: (...args: unknown[]) => processJobMock(...args),
}));

const publishRetryMock = jest.fn();
const publishDeadLetterMock = jest.fn();
jest.mock("../../queue/retryPublisher", () => ({
  publishRetry: (...args: unknown[]) => publishRetryMock(...args),
  publishDeadLetter: (...args: unknown[]) => publishDeadLetterMock(...args),
}));

function fakeMsg(jobId: string) {
  return { content: Buffer.from(JSON.stringify({ jobId })) };
}

function fakeJob(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "job-1",
    type: "test_type",
    payload: {},
    status: "PROCESSING",
    attempt_count: 1,
    max_attempts: 5,
    last_error: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    total_attempt_count: 1,
    replay_count: 0,
    last_dead_lettered_at: null,
    last_dead_letter_reason: null,
    ...overrides,
  };
}

async function bootConsumer() {
  const connections: FakeConnection[] = [];
  connectMock.mockImplementation(async () => {
    const conn = new FakeConnection();
    connections.push(conn);
    return conn;
  });

  const mod = await import("../../consumer");
  await mod.startConsumer();

  const channel = connections[0]!.channels[0]!;
  const handler = channel.consume.mock.calls[0]![1] as (msg: unknown) => Promise<void>;
  return { mod, channel, handler };
}

describe("apps/worker DB-error backoff before requeue (Phase 15)", () => {
  beforeEach(() => {
    jest.resetModules();
    connectMock.mockReset();
    claimJobMock.mockReset();
    getJobByIdMock.mockReset();
    markCompletedMock.mockReset();
    markRetryingMock.mockReset();
    markDeadLetteredMock.mockReset();
    processJobMock.mockReset();
    publishRetryMock.mockReset();
    publishDeadLetterMock.mockReset();
  });

  it("computeDbErrorBackoffMs: base delay on the 1st error, doubling, capped at ~30s", async () => {
    const { computeDbErrorBackoffMs } = await import("../../consumer");
    expect(computeDbErrorBackoffMs(1)).toBe(1000);
    expect(computeDbErrorBackoffMs(2)).toBe(2000);
    expect(computeDbErrorBackoffMs(3)).toBe(4000);
    expect(computeDbErrorBackoffMs(4)).toBe(8000);
    expect(computeDbErrorBackoffMs(5)).toBe(16000);
    expect(computeDbErrorBackoffMs(6)).toBe(30000); // 32000 capped to 30000
    expect(computeDbErrorBackoffMs(10)).toBe(30000); // stays capped
  });

  it("the first consecutive DB error during claim uses the base (~1s) delay before requeueing", async () => {
    jest.useFakeTimers();
    try {
      claimJobMock.mockRejectedValueOnce(new Error("simulated: Postgres unreachable"));
      const { channel, handler } = await bootConsumer();

      const pending = handler(fakeMsg("job-1"));

      await jest.advanceTimersByTimeAsync(0);
      expect(channel.nack).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(999);
      expect(channel.nack).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1); // total elapsed: 1000ms
      expect(channel.nack).toHaveBeenCalledTimes(1);
      expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, true);
      expect(channel.ack).not.toHaveBeenCalled();

      await pending;
    } finally {
      jest.useRealTimers();
    }
  });

  it("a second consecutive DB error doubles the delay to ~2s", async () => {
    jest.useFakeTimers();
    try {
      claimJobMock.mockRejectedValue(new Error("simulated: Postgres still unreachable"));
      const { channel, handler } = await bootConsumer();

      // First error: base delay (1000ms).
      const first = handler(fakeMsg("job-1"));
      await jest.advanceTimersByTimeAsync(1000);
      expect(channel.nack).toHaveBeenCalledTimes(1);
      await first;

      // Second, CONSECUTIVE error (no successful claim in between):
      // delay should now be 2000ms, not 1000ms again.
      const second = handler(fakeMsg("job-2"));
      await jest.advanceTimersByTimeAsync(1999);
      expect(channel.nack).toHaveBeenCalledTimes(1); // not yet
      await jest.advanceTimersByTimeAsync(1); // total elapsed: 2000ms
      expect(channel.nack).toHaveBeenCalledTimes(2);
      await second;
    } finally {
      jest.useRealTimers();
    }
  });

  it("a successful claim resets the backoff -- the next DB error again uses the base delay", async () => {
    jest.useFakeTimers();
    try {
      const { channel, handler } = await bootConsumer();

      // Error #1 -> base delay, nack.
      claimJobMock.mockRejectedValueOnce(new Error("simulated: Postgres unreachable"));
      const first = handler(fakeMsg("job-1"));
      await jest.advanceTimersByTimeAsync(1000);
      expect(channel.nack).toHaveBeenCalledTimes(1);
      await first;

      // A successful claim (job not claimable -> ack path) in between --
      // claimJob() itself did not throw, so this must reset the counter.
      claimJobMock.mockResolvedValueOnce(null);
      getJobByIdMock.mockResolvedValueOnce(null);
      const second = handler(fakeMsg("job-2"));
      await jest.advanceTimersByTimeAsync(0);
      expect(channel.ack).toHaveBeenCalledTimes(1);
      expect(channel.nack).toHaveBeenCalledTimes(1); // unchanged
      await second;

      // Error #2, AFTER the reset -> should be base delay again (1000ms),
      // not 2000ms.
      claimJobMock.mockRejectedValueOnce(new Error("simulated: Postgres unreachable again"));
      const third = handler(fakeMsg("job-3"));
      await jest.advanceTimersByTimeAsync(999);
      expect(channel.nack).toHaveBeenCalledTimes(1); // not yet -- still within base delay
      await jest.advanceTimersByTimeAsync(1); // total elapsed: 1000ms
      expect(channel.nack).toHaveBeenCalledTimes(2);
      await third;
    } finally {
      jest.useRealTimers();
    }
  });

  it("a business-logic failure (not a DB error) is acked immediately, with no backoff delay", async () => {
    jest.useFakeTimers();
    try {
      claimJobMock.mockResolvedValueOnce(fakeJob({ attempt_count: 1, max_attempts: 5 }));
      processJobMock.mockRejectedValueOnce(new Error("simulated business-logic failure"));
      markRetryingMock.mockResolvedValueOnce(fakeJob());
      publishRetryMock.mockResolvedValueOnce(undefined);

      const { channel, handler } = await bootConsumer();

      const pending = handler(fakeMsg("job-1"));
      await jest.advanceTimersByTimeAsync(0);

      expect(channel.ack).toHaveBeenCalledTimes(1);
      expect(channel.nack).not.toHaveBeenCalled();
      expect(markRetryingMock).toHaveBeenCalledTimes(1);
      expect(publishRetryMock).toHaveBeenCalledTimes(1);

      await pending;
    } finally {
      jest.useRealTimers();
    }
  });

  it("a DB/publish error while recording the retry outcome also backs off before requeueing", async () => {
    jest.useFakeTimers();
    try {
      claimJobMock.mockResolvedValueOnce(fakeJob({ attempt_count: 1, max_attempts: 5 }));
      processJobMock.mockRejectedValueOnce(new Error("simulated business-logic failure"));
      markRetryingMock.mockRejectedValueOnce(new Error("simulated: Postgres unreachable while recording retry"));

      const { channel, handler } = await bootConsumer();

      const pending = handler(fakeMsg("job-1"));

      await jest.advanceTimersByTimeAsync(0);
      expect(channel.nack).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(999);
      expect(channel.nack).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1); // total elapsed: 1000ms -- base delay, since the prior claim succeeded and reset the counter
      expect(channel.nack).toHaveBeenCalledTimes(1);
      expect(channel.ack).not.toHaveBeenCalled();

      await pending;
    } finally {
      jest.useRealTimers();
    }
  });
});
