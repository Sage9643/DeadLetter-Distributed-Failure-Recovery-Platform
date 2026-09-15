import { useEffect, useRef, useState } from "react";

export interface JobUpdatedEvent {
  type: "job.updated";
  jobId: string;
  status: string;
  updatedAt: string;
}

export type ConnectionState = "connecting" | "open" | "closed";

// WebSocket is a NOTIFICATION channel only. This hook never exposes job
// data as authoritative -- only the fact that something changed, so
// callers know to refetch via REST. A dropped event or a fully failed
// connection never leaves the dashboard permanently incorrect: callers
// are expected to also refresh via REST independently (see App.tsx's
// periodic refresh).
export function useJobEvents(): { lastEvent: JobUpdatedEvent | null; connectionState: ConnectionState } {
  const [lastEvent, setLastEvent] = useState<JobUpdatedEvent | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const reconnectAttempt = useRef(0);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      setConnectionState("connecting");
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

      ws.onopen = () => {
        reconnectAttempt.current = 0;
        setConnectionState("open");
      };

      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          if (parsed && parsed.type === "job.updated") {
            setLastEvent(parsed);
          }
        } catch {
          // Malformed event -- ignored. REST remains authoritative regardless.
        }
      };

      ws.onclose = () => {
        setConnectionState("closed");
        if (cancelled) return;
        const delay = Math.min(1000 * 2 ** reconnectAttempt.current, 15000);
        reconnectAttempt.current += 1;
        reconnectTimer = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        ws?.close();
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []);

  return { lastEvent, connectionState };
}