// Phase 16: public security baseline, dashboard side. The dashboard
// must respect the same authorization boundary as the API (replay is
// a state-changing, operator-only action -- see
// apps/api/src/middleware/auth.ts). The operator's API key is NEVER
// baked into the built JS bundle (that would defeat the whole point
// of requiring it) -- it is entered at runtime by the operator and
// held only in this browser tab's sessionStorage, cleared when the
// tab closes. Read/GET operations never need this key at all; only
// the replay action does.

const STORAGE_KEY = "deadletter.operatorApiKey";

export function getStoredApiKey(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    // sessionStorage can throw in some locked-down browser contexts --
    // treat as "no key stored" rather than crashing the dashboard.
    return null;
  }
}

export function setStoredApiKey(key: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, key);
  } catch {
    // Best-effort only -- see getStoredApiKey.
  }
}

export function clearStoredApiKey(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Best-effort only -- see getStoredApiKey.
  }
}
