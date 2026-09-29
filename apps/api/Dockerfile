# Phase 16: production Docker image for the API.
#
# Multi-stage: the build stage has the full monorepo + devDependencies
# (needed to run `tsc`); the final stage carries ONLY the compiled
# dist/ output plus production dependencies -- no TypeScript compiler,
# no test tooling, no source .ts files, no dev server. This is an npm
# workspace (see the root package.json), so the build stage needs the
# workspace root's package.json/package-lock.json alongside this app's
# own, or npm's workspace resolution fails.

FROM node:22-alpine AS build
WORKDIR /repo

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
# Other workspaces are not needed to build the API, but `npm ci` at the
# workspace root reads the whole tree's package.json files to resolve
# the lockfile -- copying just the manifests (not source) keeps this
# stage's Docker layer cache cheap to invalidate correctly.
COPY apps/worker/package.json apps/worker/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json

RUN npm ci

COPY apps/api ./apps/api
RUN npm run build -w apps/api

FROM node:22-alpine AS production
ENV NODE_ENV=production
WORKDIR /app

COPY apps/api/package.json ./package.json
# Production-only dependencies -- no ts-jest/typescript/@types/* etc.
# This is a plain (non-workspace) install in the final stage: only
# this one app's package.json is present here, so npm has nothing to
# resolve against workspace siblings and installs exactly what
# apps/api needs to RUN.
RUN npm install --omit=dev

COPY --from=build /repo/apps/api/dist ./dist

# Runs as a non-root user -- the node:22-alpine base image already
# defines one (uid 1000, "node"), no need to create a new one.
USER node

EXPOSE 3000

# Uses BusyBox wget (present in node:alpine) rather than curl, which
# is not installed by default -- avoids adding a package just for the
# healthcheck. Checks liveness (GET /api/health), not readiness --
# Docker's healthcheck deciding "unhealthy" should reflect "the
# process itself is broken", not "a dependency is briefly down" (that
# is exactly the liveness/readiness distinction routes/health.ts
# already documents).
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O- http://localhost:3000/api/health || exit 1

CMD ["node", "dist/index.js"]
