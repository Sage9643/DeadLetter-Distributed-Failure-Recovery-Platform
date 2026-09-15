import { createJobSchema, jobIdParamSchema } from "../../validation/jobSchema";

describe("createJobSchema", () => {
  it("accepts a valid type and payload", () => {
    expect(createJobSchema.safeParse({ type: "send_email", payload: { to: "a@b.com" } }).success).toBe(true);
  });

  it("accepts an empty payload object", () => {
    expect(createJobSchema.safeParse({ type: "noop", payload: {} }).success).toBe(true);
  });

  it("rejects an empty type string", () => {
    expect(createJobSchema.safeParse({ type: "", payload: {} }).success).toBe(false);
  });

  it("rejects a missing type", () => {
    expect(createJobSchema.safeParse({ payload: {} }).success).toBe(false);
  });

  it("rejects a missing payload", () => {
    expect(createJobSchema.safeParse({ type: "x" }).success).toBe(false);
  });

  it("rejects a non-object payload", () => {
    expect(createJobSchema.safeParse({ type: "x", payload: "not-an-object" }).success).toBe(false);
  });
});

describe("jobIdParamSchema", () => {
  it("accepts a well-formed UUID", () => {
    expect(jobIdParamSchema.safeParse("6d0addf3-921c-47f5-86bb-ca495545d415").success).toBe(true);
  });

  it("rejects a non-UUID string", () => {
    expect(jobIdParamSchema.safeParse("not-a-uuid").success).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(jobIdParamSchema.safeParse("").success).toBe(false);
  });

  it("rejects a UUID-shaped string with an invalid character", () => {
    expect(jobIdParamSchema.safeParse("6d0addf3-921c-47f5-86bb-ca495545d41z").success).toBe(false);
  });
});