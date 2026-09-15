import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import App from "../App";

class MockWebSocket {
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
  constructor(public url: string) {}
}

beforeEach(() => {
  // @ts-expect-error test override of global WebSocket
  global.WebSocket = MockWebSocket;
});

describe("App", () => {
  it("loads and displays stats and recent jobs on mount", async () => {
    global.fetch = vi.fn((url: string) => {
      if (url === "/api/stats") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              totalJobs: 5,
              byStatus: { QUEUED: 1, PROCESSING: 0, RETRYING: 0, COMPLETED: 4, DEAD_LETTERED: 0, FAILED: 0 },
              totalReplays: 0,
              totalAttempts: 9,
            }),
        } as Response);
      }
      if (url === "/api/jobs") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ jobs: [] }) } as Response);
      }
      return Promise.reject(new Error("unexpected url " + url));
    }) as unknown as typeof fetch;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("DeadLetter Operational Dashboard")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText("5")).toBeInTheDocument();
    });
    expect(screen.getByText("No jobs yet.")).toBeInTheDocument();
  });

  it("shows an error state and does not crash when the API is unavailable", async () => {
    global.fetch = vi.fn(() => Promise.reject(new Error("network down"))) as unknown as typeof fetch;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/Unable to load dashboard data/)).toBeInTheDocument();
    });
  });

  it("does not crash on a malformed stats response", async () => {
    global.fetch = vi.fn((url: string) => {
      if (url === "/api/stats") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(null) } as Response);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ jobs: [] }) } as Response);
    }) as unknown as typeof fetch;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("DeadLetter Operational Dashboard")).toBeInTheDocument();
    });
  });
});