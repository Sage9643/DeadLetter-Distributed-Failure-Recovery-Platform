const BASE_DELAY_MS = 2000;
const MULTIPLIER = 2;
const MAX_DELAY_MS = 20000;

// attemptCount is the job's attempt_count AFTER the failed attempt
// (i.e. already incremented by markProcessing).
export function calculateBackoffMs(attemptCount: number): number {
  const delay = BASE_DELAY_MS * Math.pow(MULTIPLIER, Math.max(attemptCount - 1, 0));
  return Math.min(delay, MAX_DELAY_MS);
}