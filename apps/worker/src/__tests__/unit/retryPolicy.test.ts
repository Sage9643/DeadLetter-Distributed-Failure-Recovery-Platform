import { calculateBackoffMs } from "../../retry/retryPolicy";

describe("calculateBackoffMs", () => {
  it("returns 2000ms for the first attempt", () => {
    expect(calculateBackoffMs(1)).toBe(2000);
  });

  it("doubles for each subsequent attempt", () => {
    expect(calculateBackoffMs(2)).toBe(4000);
    expect(calculateBackoffMs(3)).toBe(8000);
    expect(calculateBackoffMs(4)).toBe(16000);
  });

  it("caps at 20000ms even for large attempt counts", () => {
    expect(calculateBackoffMs(5)).toBe(20000);
    expect(calculateBackoffMs(10)).toBe(20000);
    expect(calculateBackoffMs(100)).toBe(20000);
  });

  it("treats attemptCount of 0 or negative the same as 1", () => {
    expect(calculateBackoffMs(0)).toBe(2000);
    expect(calculateBackoffMs(-5)).toBe(2000);
  });
});