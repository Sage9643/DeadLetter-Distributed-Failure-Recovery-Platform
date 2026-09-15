import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import JobDetail from "../components/JobDetail";
import * as client from "../api/client";

const baseJob = {
  id: "e25c2f4a-a3b8-4610-b46f-3c493bc0f17d",
  type: "send_email",
  payload: {},
  status: "DEAD_LETTERED",
  attempt_count: 5,
  max_attempts: 5,
  last_error: "boom",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:05.000Z",
  total_attempt_count: 5,
  replay_count: 0,
  last_dead_lettered_at: "2026-01-01T00:00:05.000Z",
  last_dead_letter_reason: "Simulated failure",
};

describe("JobDetail", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a replay button for DEAD_LETTERED jobs and handles success", async () => {
    vi.spyOn(client, "replayJob").mockResolvedValue({ jobId: baseJob.id, status: "QUEUED", replayCount: 1 });
    const onReplayed = vi.fn();
    render(<JobDetail job={baseJob} onBack={() => {}} onReplayed={onReplayed} />);

    fireEvent.click(screen.getByText("Replay Job"));

    await waitFor(() => {
      expect(screen.getByText(/Replay queued/)).toBeInTheDocument();
    });
    expect(onReplayed).toHaveBeenCalled();
  });

  it("shows a 409 conflict message on replay", async () => {
    vi.spyOn(client, "replayJob").mockRejectedValue(new client.ApiError(409, { error: "conflict" }));
    render(<JobDetail job={baseJob} onBack={() => {}} onReplayed={() => {}} />);

    fireEvent.click(screen.getByText("Replay Job"));

    await waitFor(() => {
      expect(screen.getByText(/no longer in a replayable state/)).toBeInTheDocument();
    });
  });

  it("shows a 404 message on replay", async () => {
    vi.spyOn(client, "replayJob").mockRejectedValue(new client.ApiError(404, { error: "not found" }));
    render(<JobDetail job={baseJob} onBack={() => {}} onReplayed={() => {}} />);

    fireEvent.click(screen.getByText("Replay Job"));

    await waitFor(() => {
      expect(screen.getByText("Job not found.")).toBeInTheDocument();
    });
  });

  it("does not show a replay button for non-DEAD_LETTERED jobs", () => {
    render(<JobDetail job={{ ...baseJob, status: "COMPLETED" }} onBack={() => {}} onReplayed={() => {}} />);
    expect(screen.queryByText("Replay Job")).not.toBeInTheDocument();
  });
});