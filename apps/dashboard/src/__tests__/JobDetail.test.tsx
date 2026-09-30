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
    // Restores any spy (including window.prompt, spied on per-test
    // below) to its original jsdom implementation before the NEXT
    // test runs, so a prompt mock from one test can never leak into
    // another. Also clears sessionStorage so a stored operator API key
    // from one test (handleReplay() -> setStoredApiKey() on a
    // successful prompt) never lets a LATER test skip the prompt --
    // every replay test below exercises the exact same
    // getStoredApiKey() -> null -> window.prompt() -> handler path,
    // deterministically, regardless of test order.
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it("shows a replay button for DEAD_LETTERED jobs and handles success", async () => {
    vi.spyOn(client, "replayJob").mockResolvedValue({ jobId: baseJob.id, status: "QUEUED", replayCount: 1 });
    // jsdom does not implement window.prompt (throws "Not implemented:
    // window.prompt" if called for real) -- handleReplay() calls it
    // first, before ever reaching replayJob(), whenever no operator key
    // is already stored. Stubbing a truthy return value lets the
    // handler proceed exactly as it would for a real operator entering
    // a key, so this test genuinely exercises handleReplay()'s full
    // path into the replayJob() mock above, not just the prompt itself.
    vi.spyOn(window, "prompt").mockReturnValue("test-operator-key");
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
    // See the success test above for why this is needed: handleReplay()
    // calls window.prompt() before replayJob(), and jsdom's real
    // implementation throws rather than returning a value.
    vi.spyOn(window, "prompt").mockReturnValue("test-operator-key");
    render(<JobDetail job={baseJob} onBack={() => {}} onReplayed={() => {}} />);

    fireEvent.click(screen.getByText("Replay Job"));

    await waitFor(() => {
      expect(screen.getByText(/no longer in a replayable state/)).toBeInTheDocument();
    });
  });

  it("shows a 404 message on replay", async () => {
    vi.spyOn(client, "replayJob").mockRejectedValue(new client.ApiError(404, { error: "not found" }));
    // See the success test above for why this is needed: handleReplay()
    // calls window.prompt() before replayJob(), and jsdom's real
    // implementation throws rather than returning a value.
    vi.spyOn(window, "prompt").mockReturnValue("test-operator-key");
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