import { NonRetryableError } from "./errors";

export interface ProcessableJob {
  type: string;
  payload: Record<string, unknown>;
}

// Stub processor. Real job-type-specific logic will replace this later.
// Deterministic failure hooks for testing:
//   payload.shouldFail === true            -> retryable failure
//   payload.shouldFailPermanently === true -> non-retryable, straight to DLQ
export async function processJob(job: ProcessableJob): Promise<void> {
  if (job.payload?.shouldFailPermanently === true) {
    throw new NonRetryableError(`Simulated non-retryable failure for job type "${job.type}"`);
  }
  if (job.payload?.shouldFail === true) {
    throw new Error(`Simulated failure for job type "${job.type}"`);
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}