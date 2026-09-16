import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import Overview from "../components/Overview";

describe("Overview", () => {
  it("renders total counts, per-status rows, and pending outbox events", () => {
    render(
      <Overview
        stats={{
          totalJobs: 10,
          byStatus: { QUEUED: 2, PROCESSING: 1, RETRYING: 0, COMPLETED: 5, DEAD_LETTERED: 2, FAILED: 0 },
          totalReplays: 3,
          totalAttempts: 20,
          pendingOutboxEvents: 4,
        }}
      />
    );
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("QUEUED")).toBeInTheDocument();
    expect(screen.getByText("DEAD_LETTERED")).toBeInTheDocument();
    expect(screen.getByText("Pending Outbox Events")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
  });
});