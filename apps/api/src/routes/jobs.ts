import { Router } from "express";
import { createJobSchema, jobIdParamSchema } from "../validation/jobSchema";
import { createJob, getJobById, claimReplay, listRecentJobs } from "../services/jobService";
import { env } from "../config/env";

export const jobsRouter = Router();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

jobsRouter.post("/", async (req, res) => {
  const parsed = createJobSchema.safeParse(req.body);

  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.format() }, "Job creation validation failed");
    return res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
  }

  const job = await createJob(parsed.data);
  req.log.info({ jobId: job.id }, "Job created");

  res.status(201).json({ jobId: job.id, status: job.status });
});

jobsRouter.get("/", async (req, res) => {
  const jobs = await listRecentJobs();
  req.log.info({ count: jobs.length }, "Recent jobs list requested");
  res.json({ jobs });
});

jobsRouter.get("/:id", async (req, res) => {
  const parsedId = jobIdParamSchema.safeParse(req.params.id);
  if (!parsedId.success) {
    req.log.warn({ id: req.params.id }, "Malformed job id in GET request");
    return res.status(400).json({ error: "Invalid job id format" });
  }

  const job = await getJobById(parsedId.data);

  if (!job) {
    req.log.warn({ jobId: parsedId.data }, "Job not found");
    return res.status(404).json({ error: "Job not found" });
  }

  res.json(job);
});

// Phase 6: explicit replay. DEAD_LETTERED -> QUEUED only. See
// docs/failure-handling.md for the full state-machine table and
// docs/engineering-decisions.md for why each other status is rejected.
jobsRouter.post("/:id/replay", async (req, res) => {
  const parsedId = jobIdParamSchema.safeParse(req.params.id);
  if (!parsedId.success) {
    req.log.warn({ id: req.params.id }, "Malformed job id in replay request");
    return res.status(400).json({ error: "Invalid job id format" });
  }
  const jobId = parsedId.data;
  const log = req.log.child({ jobId });

  log.info("Replay request received");

  // TEST-ONLY: widens the window between request receipt and the atomic
  // replay claim, so two concurrently-fired replay requests can be
  // reliably shown to race on the actual SQL claim. Disabled (0) by
  // default. See docs/failure-handling.md, Phase 6.
  if (env.REPLAY_TEST_DELAY_MS > 0) {
    log.warn({ delayMs: env.REPLAY_TEST_DELAY_MS }, "REPLAY_TEST_DELAY_MS is set -- TEST-ONLY delay active. Do not use in production.");
    await sleep(env.REPLAY_TEST_DELAY_MS);
  }

  log.info("Attempting replay claim");
  const job = await claimReplay(jobId);

  if (!job) {
    const current = await getJobById(jobId);

    if (!current) {
      log.warn("Replay requested for nonexistent job");
      return res.status(404).json({ error: "Job not found" });
    }

    log.warn({ currentStatus: current.status }, "Replay rejected -- job not in DEAD_LETTERED state");
    return res.status(409).json({
      error: "Job is not in a replayable state",
      currentStatus: current.status,
    });
  }

   log.info({ replayCount: job.replay_count }, "Replay claim succeeded; outbox event recorded for dispatch");

  // Phase 10: the DEAD_LETTERED->QUEUED update and its outbox event
  // were committed atomically inside claimReplay (see jobService.ts).
  // The actual RabbitMQ publish is now performed asynchronously by the
  // outbox dispatcher, closing the dual-write gap previously tracked
  // here since Phase 0/2/6. See engineering-decisions.md -- this does
  // NOT provide exactly-once delivery, only durable publication intent.

  res.status(200).json({
    jobId: job.id,
    status: job.status,
    replayCount: job.replay_count,
  });
});