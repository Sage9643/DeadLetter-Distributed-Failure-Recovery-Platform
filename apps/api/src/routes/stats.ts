import { Router } from "express";
import { getStats } from "../services/statsService";

export const statsRouter = Router();

statsRouter.get("/", async (req, res) => {
  const stats = await getStats();
  req.log.info({ stats }, "Stats requested");
  res.json(stats);
});