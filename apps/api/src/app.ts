import express from "express";
import pinoHttp from "pino-http";
import { jobsRouter } from "./routes/jobs";
import { healthRouter } from "./routes/health";
import { statsRouter } from "./routes/stats";

export const app = express();

app.use(pinoHttp());
app.use(express.json());

app.use("/api/health", healthRouter);
app.use("/api/jobs", jobsRouter);
app.use("/api/stats", statsRouter);