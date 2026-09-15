import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useJobEvents } from "../ws/useJobEvents";

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

describe("useJobEvents", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    // @ts-expect-error test override of global WebSocket
    global.WebSocket = MockWebSocket;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts in connecting state and moves to open on connect", async () => {
    const { result } = renderHook(() => useJobEvents());
    expect(result.current.connectionState).toBe("connecting");

    act(() => {
      MockWebSocket.instances[0]!.onopen?.();
    });

    await waitFor(() => {
      expect(result.current.connectionState).toBe("open");
    });
  });

  it("captures a job.updated event as a notification (jobId/status only)", async () => {
    const { result } = renderHook(() => useJobEvents());
    const socket = MockWebSocket.instances[0]!;

    act(() => {
      socket.onopen?.();
    });

    act(() => {
      socket.onmessage?.({
        data: JSON.stringify({ type: "job.updated", jobId: "abc", status: "COMPLETED", updatedAt: "2026-01-01T00:00:00.000Z" }),
      });
    });

    await waitFor(() => {
      expect(result.current.lastEvent).toEqual({
        type: "job.updated",
        jobId: "abc",
        status: "COMPLETED",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
    });
  });

  it("moves to closed state on disconnect", async () => {
    const { result } = renderHook(() => useJobEvents());
    const socket = MockWebSocket.instances[0]!;

    act(() => {
      socket.onopen?.();
    });

    act(() => {
      socket.close();
    });

    await waitFor(() => {
      expect(result.current.connectionState).toBe("closed");
    });
  });
});