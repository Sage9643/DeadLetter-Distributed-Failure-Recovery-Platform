import { EventEmitter } from "events";

// Phase 16 (Final Finalization Master Prompt -- Correctness Hardening,
// item 1): resolves the finding from the final engineering audit that
// apps/worker/src/consumer.ts previously called markCompleted(jobId)
// INSIDE the same try block as processJob(job). If processJob()
// succeeded but markCompleted() then threw (e.g. a concurrent
// stale-PROCESSING reclaim already moved the job to a different
// status), the shared catch block would misclassify that as a
// PROCESSING FAILURE -- attempting markRetrying/markDeadLettered with
// markCompleted's bookkeeping error as if it were the real failure
// reason, and potentially re-running the job's side effects on
// redelivery even though the work had already genuinely succeeded.
//
// The fix moves markCompleted() into its own try/catch, entered only
// after processJob() has already succeeded. A markCompleted() failure
// now backs off and requeues (reusing the SAME backoffBeforeRequeue +
// nack pattern already used by every other "we cannot durably record
// what happened" path in this file), and explicitly does NOT call
// markRetrying, markDeadLettered, publishRetry, or publishDeadLetter --
// this is the assertion this test file exists to make.
//
// Same mocking pattern as dbErrorBackoff.test.ts (amqplib + jobService
// + jobProcessor + retryPublisher mocked) for the same reason: this
// specific failure sequence (a successful processJob immediately
// followed by a failing markCompleted) is not reliably triggerable
// against a real, healthy Postgres inside a Jest run.

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

describe("apps/worker: processJob success + markCompleted failure is not misclassified (Phase 16)", () => {
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

  it("regression guard: processJob success + markCompleted success still acks normally", async () => {
    claimJobMock.mockResolvedValueOnce(fakeJob());
    processJobMock.mockResolvedValueOnce(undefined);
    markCompletedMock.mockResolvedValueOnce(fakeJob({ status: "COMPLETED" }));

    const { channel, handler } = await bootConsumer();
    await handler(fakeMsg("job-1"));

    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(channel.nack).not.toHaveBeenCalled();
    expect(markRetryingMock).not.toHaveBeenCalled();
    expect(markDeadLetteredMock).not.toHaveBeenCalled();
  });

  it("processJob succeeds but markCompleted throws: requeues via backoff, and is NOT classified as a processing failure", async () => {
    jest.useFakeTimers();
    try {
      claimJobMock.mockResolvedValueOnce(fakeJob());
      processJobMock.mockResolvedValueOnce(undefined);
      markCompletedMock.mockRejectedValueOnce(
        new Error("simulated: job no longer in PROCESSING state (lost race with a stale reclaim)")
      );

      const { channel, handler } = await bootConsumer();
      const pending = handler(fakeMsg("job-1"));

      // Base backoff delay (1000ms) -- same shape as every other
      // DB-error requeue path in this file.
      await jest.advanceTimersByTimeAsync(999);
      expect(channel.nack).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);

      expect(channel.nack).toHaveBeenCalledTimes(1);
      expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, true);
      expect(channel.ack).not.toHaveBeenCalled();

      // The critical assertion: a markCompleted() failure must NEVER be
      // routed through the retry/dead-letter classification. Before the
      // fix, this exact scenario would have called markRetrying or
      // markDeadLettered with markCompleted's bookkeeping error message
      // as if it were the real processing failure reason.
      expect(markRetryingMock).not.toHaveBeenCalled();
      expect(markDeadLetteredMock).not.toHaveBeenCalled();
      expect(publishRetryMock).not.toHaveBeenCalled();
      expect(publishDeadLetterMock).not.toHaveBeenCalled();

      await pending;
    } finally {
      jest.useRealTimers();
    }
  });

  it("a genuine processing failure is still classified and retried normally (unaffected by this fix)", async () => {
    claimJobMock.mockResolvedValueOnce(fakeJob({ attempt_count: 1, max_attempts: 5 }));
    processJobMock.mockRejectedValueOnce(new Error("simulated business-logic failure"));
    markRetryingMock.mockResolvedValueOnce(fakeJob());
    publishRetryMock.mockResolvedValueOnce(undefined);

    const { channel, handler } = await bootConsumer();
    await handler(fakeMsg("job-1"));

    expect(markRetryingMock).toHaveBeenCalledTimes(1);
    expect(publishRetryMock).toHaveBeenCalledTimes(1);
    expect(markCompletedMock).not.toHaveBeenCalled();
    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(channel.nack).not.toHaveBeenCalled();
  });
});
