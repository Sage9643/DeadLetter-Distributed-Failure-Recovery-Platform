import { EventEmitter } from "events";

// Phase 15 (see docs/incidents-and-failures.md and
// docs/engineering-decisions.md): apps/worker/src/db/pool.ts's
// pool-level "error" handler previously called process.exit(1) on ANY
// event -- including a background/idle-client failure that
// node-postgres's own Pool already recovers from internally (it
// discards the errored client and lazily creates a fresh one on the
// next query). A pool "error" event cannot be deterministically
// triggered against a real, healthy Postgres inside a Jest run, so
// "pg" is mocked here with a small EventEmitter-based fake Pool -- the
// same narrow, deliberate exception Phase 14 used for amqplib.

class FakePgPool extends EventEmitter {
  query = jest.fn();
  end = jest.fn();
}

const poolInstances: FakePgPool[] = [];

jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => {
    const p = new FakePgPool();
    poolInstances.push(p);
    return p;
  }),
}));

describe("apps/worker PostgreSQL pool error handling (Phase 15)", () => {
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    poolInstances.length = 0;
    exitSpy = jest.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${String(code)}) was called`);
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("logs a pool error but does not exit or throw out of the process", async () => {
    await import("../../db/pool");
    expect(poolInstances).toHaveLength(1);

    const err = new Error("simulated: Postgres connection reset (idle client)");

    expect(() => {
      poolInstances[0]!.emit("error", err);
    }).not.toThrow();

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("keeps logging on repeated pool errors without ever exiting", async () => {
    await import("../../db/pool");
    expect(poolInstances).toHaveLength(1);

    for (let i = 0; i < 3; i += 1) {
      expect(() => {
        poolInstances[0]!.emit("error", new Error(`simulated Postgres error #${i}`));
      }).not.toThrow();
    }

    expect(exitSpy).not.toHaveBeenCalled();
  });
});
