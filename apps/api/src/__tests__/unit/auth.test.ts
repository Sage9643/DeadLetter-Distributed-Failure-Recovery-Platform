import type { Request, Response, NextFunction } from "express";

// Phase 16: requireApiKey tested directly against a hand-built
// req/res/next, same style as unit/rateLimiter.test.ts -- no real
// Express app or network needed to exercise this middleware's logic.
//
// config/env is mocked with a single mutable object (mockEnv) so each
// test can set/unset API_KEY without needing a real environment
// variable or process restart -- requireApiKey reads env.API_KEY
// freshly on every call, so mutating this shared object between tests
// is picked up correctly.

const mockEnv: { API_KEY?: string; NODE_ENV: string } = { NODE_ENV: "test" };

jest.mock("../../config/env", () => ({
  env: mockEnv,
}));

import { requireApiKey, API_KEY_HEADER } from "../../middleware/auth";

function mockReq(headerValue?: string): Request {
  return {
    header: (name: string) => (name.toLowerCase() === API_KEY_HEADER ? headerValue : undefined),
    log: { debug: jest.fn(), warn: jest.fn() },
  } as unknown as Request;
}

interface MockRes {
  statusCode: number | null;
  body: unknown;
  status: (code: number) => MockRes;
  json: (body: unknown) => MockRes;
}

function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: null,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}

describe("requireApiKey", () => {
  afterEach(() => {
    delete mockEnv.API_KEY;
  });

  it("allows the request when no API_KEY is configured (dev/test-only fallback)", () => {
    const req = mockReq(undefined);
    const res = mockRes();
    const next = jest.fn();

    requireApiKey(req, res as unknown as Response, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
  });

  it("rejects with 401 when API_KEY is configured and no header is provided", () => {
    mockEnv.API_KEY = "test-secret-123";
    const req = mockReq(undefined);
    const res = mockRes();
    const next = jest.fn();

    requireApiKey(req, res as unknown as Response, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized", reason: "missing_or_invalid_api_key" });
  });

  it("rejects with 401 when the provided key does not match", () => {
    mockEnv.API_KEY = "test-secret-123";
    const req = mockReq("wrong-key");
    const res = mockRes();
    const next = jest.fn();

    requireApiKey(req, res as unknown as Response, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("allows the request when the provided key matches exactly", () => {
    mockEnv.API_KEY = "test-secret-123";
    const req = mockReq("test-secret-123");
    const res = mockRes();
    const next = jest.fn();

    requireApiKey(req, res as unknown as Response, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
  });

  it("is case-sensitive and rejects a key differing only in case", () => {
    mockEnv.API_KEY = "Test-Secret-123";
    const req = mockReq("test-secret-123");
    const res = mockRes();
    const next = jest.fn();

    requireApiKey(req, res as unknown as Response, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});
