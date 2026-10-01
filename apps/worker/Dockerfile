# Phase 16: production Docker image for the worker. Same multi-stage
# shape as apps/api/Dockerfile -- see its comments for the workspace/
# npm-ci rationale, which applies identically here.
#
# No Docker HEALTHCHECK is defined: the worker has no HTTP surface to
# probe (it is a long-lived RabbitMQ consumer, not a server), and
# adding one purely to satisfy a "must have a healthcheck" checkbox
# would mean either a fake always-true check (worthless) or a
# heartbeat-file mechanism invented solely for this purpose (more
# moving parts than the problem justifies at this project's scale).
# Liveness in production compose is instead handled the way Docker
# handles any long-running process with no probe: `restart:
# unless-stopped` reacts to the container actually exiting, and Phase
# 14/15's real, chaos-tested reconnect/backoff logic is what keeps the
# process itself alive and self-healing through RabbitMQ/Postgres
# outages without needing to exit at all.
#
# Free-tier deployment note: a minimal, non-business HTTP listener
# (src/health.ts) was added so this same image can also run as a
# Render Free Web Service, which has no background-worker service type
# and requires something listening on $PORT. This does not change the
# reasoning above for Docker Compose: no Docker-level HEALTHCHECK is
# added here, since the real health signal remains the RabbitMQ
# consumer's own logs/reconnect behavior, not an HTTP probe.

FROM node:22-alpine AS build
WORKDIR /repo

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json

RUN npm ci

COPY apps/worker ./apps/worker
RUN npm run build -w apps/worker

FROM node:22-alpine AS production
ENV NODE_ENV=production
WORKDIR /app

COPY apps/worker/package.json ./package.json
RUN npm install --omit=dev

COPY --from=build /repo/apps/worker/dist ./dist

USER node

CMD ["node", "dist/index.js"]
