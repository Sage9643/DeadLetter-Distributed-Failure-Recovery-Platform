import request from "supertest";

jest.mock("../../queue/connection", () => ({
  ...jest.requireActual("../../queue/connection"),
  checkRabbitMQHealth: jest.fn(),
}));

import { app } from "../../app";
import { pool } from "../../db/pool";
import { checkRabbitMQHealth } from "../../queue/connection";

const mockedCheckRabbitMQHealth = checkRabbitMQHealth as jest.MockedFunction<typeof checkRabbitMQHealth>;

afterAll(async () => {
  await pool.end();
});

describe("GET /api/health", () => {
  it("returns 200 and status ok (liveness, unchanged behavior)", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("GET /api/health/ready", () => {
  it("returns 200 when both Postgres and RabbitMQ are reachable", async () => {
    mockedCheckRabbitMQHealth.mockResolvedValueOnce(undefined);
    const res = await request(app).get("/api/health/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ postgres: "ok", rabbitmq: "ok" });
  });

  it("returns 503 when RabbitMQ is unreachable", async () => {
    mockedCheckRabbitMQHealth.mockRejectedValueOnce(new Error("connection refused"));
    const res = await request(app).get("/api/health/ready");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ postgres: "ok", rabbitmq: "error" });
  });
});