# Deployment

## Status: not yet publicly deployed

As of this writing, DeadLetter has **not** been deployed to a public
host. This document records the deployment architecture that was
designed and built (containerization, the production Compose
topology, the reverse-proxy/TLS plan) and exactly what is still
required to complete it. Nothing below should be read as a claim that
a live URL currently exists -- there isn't one yet, and this file will
be updated with the real one the moment there is, never before.

Why not yet: actually provisioning and reaching a real host requires
account credentials (a VPS/cloud provider account) and, for a real TLS
certificate, a domain the operator controls -- both of which only the
project owner can supply. This is exactly the kind of genuine external
blocker this project's engineering process is instructed to stop at
rather than work around or fabricate past.

## Target architecture

```
Internet
   |
   v
Caddy (reverse proxy, automatic Let's Encrypt TLS)
   |
   v  (only published port on the box)
dashboard (nginx, static build)  --/api,/ws-->  api (Express + ws)
                                                    |
                                        +-----------+-----------+
                                        v                       v
                                   postgres                 rabbitmq
                                (no published port)     (no published port,
                                                       mgmt UI not exposed)
                                        ^
                                        |
                                     worker
```

Everything runs as Docker Compose services on a **single VPS, single
region** (`infra/docker-compose.prod.yml`). This was chosen
deliberately over a multi-service/managed-database/Kubernetes
topology:

- The project's own scope rules explicitly rule out Kubernetes, Kafka,
  Redis, a service mesh, or infrastructure adopted for its own sake.
- Colocating Postgres, RabbitMQ, the API, and the worker in one region
  avoids cross-region latency that a split topology (e.g. managed DB
  in one region, compute in another) would add for no benefit at this
  scale.
- A VPS with Docker Compose has no cold starts (nothing serverless),
  matching the master finalization brief's explicit preference.
- A managed Postgres/managed queue service would add real monthly cost
  and operational surface (IAM, network peering, provider-specific
  failure modes) to solve a problem -- "I don't want to run a
  database" -- this project doesn't have: the whole point of Phases
  1-15 was building real operational competence in running Postgres
  and RabbitMQ ourselves, safely, through real failures. Replacing
  that with a managed service at the finish line would undercut the
  project's own stated learning goals.

## Containerization (complete, built, not yet run against a live
Docker daemon from this session -- see Verification below)

Three Dockerfiles, one per deployable app, all multi-stage:

- **`apps/api/Dockerfile`** -- `build` stage: full monorepo checkout,
  devDependencies included, runs `npm run build -w apps/api` (`tsc`).
  `production` stage: `node:22-alpine`, only the compiled `dist/`
  output plus `npm install --omit=dev`, runs as the non-root `node`
  user, `EXPOSE 3000`, `HEALTHCHECK` via BusyBox `wget` against
  `/api/health` (liveness, not readiness -- a not-yet-ready dependency
  should not cause Docker to kill and restart a container that is
  otherwise fine).
- **`apps/worker/Dockerfile`** -- same build/production split, no
  `HEALTHCHECK` (the worker has no HTTP surface to probe; its health
  is observed through RabbitMQ consumer state and logs, not a health
  endpoint).
- **`apps/dashboard/Dockerfile`** -- `build` stage runs `vite build`;
  `production` stage is `nginx:1.27-alpine` serving the static output
  plus a custom `nginx.conf` that reverse-proxies `/api/*` and `/ws`
  to the `api` Compose service by name (with WebSocket upgrade headers
  forwarded) and serves everything else as an SPA with cache headers
  on `/assets/`.

`.dockerignore` (repo root) excludes `node_modules`, `dist`, `.git`,
logs, `*.tsbuildinfo`, k6 result/data files, and `.env*` files from
every build context.

### Production Compose topology (`infra/docker-compose.prod.yml`)

- `postgres` and `rabbitmq`: **no published host ports** -- reachable
  only on the internal Compose network, from `api`/`worker`.
- `api` and `worker`: `depends_on` with `condition: service_healthy`
  on `postgres`/`rabbitmq`, so they never start racing an
  not-yet-ready dependency.
- `dashboard`: the **only** service with a published host port
  (`${DASHBOARD_PUBLIC_PORT:-80}:80`), reverse-proxying into the
  Compose network.
- Every secret (`API_KEY`, `DATABASE_URL`-equivalent pieces,
  `RABBITMQ_URL`-equivalent pieces, `CORS_ALLOWED_ORIGINS`) is read
  via `${VAR:?required}` interpolation -- the compose run fails loudly
  if any is unset, rather than silently substituting an empty string
  or a hardcoded default.
- `infra/.env.production.example` documents every required variable
  name with placeholder values; the real `.env.production` is
  git-ignored.

This is a deliberately separate file from the existing
`infra/docker-compose.yml`, which remains exactly as it was for local
development (bare `npm run dev` on the host, connecting to
`localhost:5432`/`localhost:5672`) -- the production topology was
never allowed to risk breaking the local dev workflow the rest of this
project's real testing depends on.

## TLS / reverse proxy plan

A Caddy instance in front of the `dashboard` container's published
port, with a Caddyfile of roughly:

```
your-domain.example {
    reverse_proxy dashboard:80
}
```

Caddy handles automatic Let's Encrypt certificate issuance and
renewal with no manual certificate management. This is not yet
written into the repo as a Compose service because it depends on the
real domain name that will be used, which is one of the two things
still needed from the project owner (see below).

## What's actually required to complete this (the real blocker)

1. **A VPS provider account** (Hetzner, DigitalOcean, or similar) --
   either an existing reachable box, or provisioning credentials.
2. **A domain or subdomain** the operator controls, for Caddy to
   request a real certificate against. Without one, the alternative is
   a bare-IP deployment with no TLS (not recommended to describe as
   "publicly deployed" in the finished sense this project is aiming
   for) or a self-signed certificate (browsers will warn on every
   visit).
3. **An access method** for actually running the deployment: either
   an SSH key/access the operator provides, or the operator running
   the documented deploy commands themselves on their own box.

None of these can be fabricated or worked around from this session --
they require a real account, a real domain, and a real decision by the
project owner about how much they want to hand over vs. do themselves.

## Verification status

- Both `infra/docker-compose.yml` (existing, unmodified) and
  `infra/docker-compose.prod.yml` (new) were validated as
  **syntactically valid YAML** via a plain `python3 -c "import
  yaml; yaml.safe_load(...)"` check. This is **not** the same as
  `docker compose config` (which also resolves variable
  interpolation, service references, and build contexts) -- that
  fuller validation, along with `docker build` for all three
  Dockerfiles and a real `docker compose -f
  infra/docker-compose.prod.yml up`, requires a real Docker daemon,
  which this session's device-bridge sandbox does not have (see
  `docs/engineering-decisions.md` and `docs/testing.md` for the fuller
  explanation of this environment constraint). These remain to be run
  by the project owner on their own machine before this is trusted as
  deployment-ready.
