import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import Overview from "../components/Overview";

describe("Overview", () => {
  it("renders total counts and per-status rows", () => {
    render(
      <Overview
        stats={{
          totalJobs: 10,
          byStatus: { QUEUED: 2, PROCESSING: 1, RETRYING: 0, COMPLETED: 5, DEAD_LETTERED: 2, FAILED: 0 },
          totalReplays: 3,
          totalAttempts: 20,
        }}
      />
    );
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("QUEUED")).toBeInTheDocument();
    expect(screen.getByText("DEAD_LETTERED")).toBeInTheDocument();
  });
});