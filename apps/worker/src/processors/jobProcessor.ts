export interface ProcessableJob {
  type: string;
  payload: Record<string, unknown>;
}

// Stub processor. Real job-type-specific logic will replace this later.
// Deterministic failure hook for testing: payload.shouldFail === true
export async function processJob(job: ProcessableJob): Promise<void> {
  if (job.payload?.shouldFail === true) {
    throw new Error(`Simulated failure for job type "${job.type}"`);
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}