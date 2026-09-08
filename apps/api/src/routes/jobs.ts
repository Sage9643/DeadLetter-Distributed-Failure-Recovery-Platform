import { Router } from "express";
import { createJobSchema } from "../validation/jobSchema";
import { createJob, getJobById } from "../services/jobService";

export const jobsRouter = Router();

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

jobsRouter.get("/:id", async (req, res) => {
  const job = await getJobById(req.params.id);

  if (!job) {
    req.log.warn({ jobId: req.params.id }, "Job not found");
    return res.status(404).json({ error: "Job not found" });
  }

  res.json(job);
});