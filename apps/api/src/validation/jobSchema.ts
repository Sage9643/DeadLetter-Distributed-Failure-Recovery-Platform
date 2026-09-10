import { z } from "zod";

export const createJobSchema = z.object({
  type: z.string().min(1, "type is required"),
  payload: z.record(z.string(), z.unknown()),
});

export type CreateJobInput = z.infer<typeof createJobSchema>;

// Phase 6: validates a route :id param is well-formed UUID syntax before
// it ever reaches a query. Directly motivated by Incident 4 (Phase 5) --
// an invalid UUID reaching Postgres raises error code 22P02, which
// without this check would surface as an unhandled 500 with a leaked
// stack trace (the same error class, just on the API instead of the
// worker). Applied to GET /:id and POST /:id/replay.
export const jobIdParamSchema = z.string().uuid("Invalid job id format");