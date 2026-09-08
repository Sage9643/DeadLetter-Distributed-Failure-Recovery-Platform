import express from "express";
import pinoHttp from "pino-http";
import { jobsRouter } from "./routes/jobs";

export const app = express();

app.use(pinoHttp());
app.use(express.json());

app.get("/api/health", (req, res) => {
  req.log.info("Health check requested");
  res.json({ status: "ok" });
});

app.use("/api/jobs", jobsRouter);