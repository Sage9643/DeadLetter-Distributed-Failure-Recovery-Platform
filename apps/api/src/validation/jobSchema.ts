import { z } from "zod";

export const createJobSchema = z.object({
  type: z.string().min(1, "type is required"),
  payload: z.record(z.string(), z.unknown()),
});

export type CreateJobInput = z.infer<typeof createJobSchema>;