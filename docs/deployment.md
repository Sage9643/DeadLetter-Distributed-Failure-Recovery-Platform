# Deployment

## Status: production topology validated locally; not yet deployed to a public host

The production Docker Compose topology (`infra/docker-compose.prod.yml`)
has been run for real, on the project owner's own Windows/Docker
Desktop environment, and validated end to end (Phase 17):

- All containers (`postgres`, `rabbitmq`, `api`, `worker`, `dashboard`)
  started and reported healthy.
- `dashboard` was confirmed as the only container with a published
  host port.
- nginx correctly served the built SPA and reverse-proxied `/api` and
  `/ws` to the `api` container.
- `GET /api/health` returned 200.
- `GET /api/health/ready` returned 200 with both `postgres` and
  `rabbitmq` reported `"ok"`.
- API-key authentication was confirmed working: an unauthenticated
  mutating request returned 401.
- A real authenticated job, submitted through the public
  `localhost:8080` entry point, completed successfully through the
  full path (API -> Postgres/outbox -> RabbitMQ -> worker -> Postgres),
  with `attempt_count=1`.
- One real bug was found and fixed by this validation: the dashboard
  container's own `HEALTHCHECK` used `http://localhost:80/`, but
  Alpine resolved `localhost` to IPv6 `::1` while nginx listens on
  IPv4 -- the healthcheck itself was failing even though nginx was
  completely fine. Fixed to `http://127.0.0.1:80/` (see
  `apps/dashboard/Dockerfile`).
- **Real chaos verification, run by the project owner against this
  same real stack:** `node apps/api/scripts/verify-chaos.js` --
  PostgreSQL outage: all checks passed (liveness stayed up, readiness
  correctly reported `postgres:error`, service recovered, a real job
  submitted after recovery completed). RabbitMQ outage: all checks
  passed (same sequence, `rabbitmq:error` correctly reported, real
  recovery, real job completed). Overall: ALL PASSED. Two real bugs in
  the verification script itself were found and fixed to get a
  trustworthy result here -- see `docs/development-log.md`'s Phase 17
  entry for both (a missing `--env-file`, which meant the first attempt
  never actually stopped either service despite appearing to test
  something; and the recovery assertions not genuinely depending on
  the outage having been observed).
- **Real WebSocket verification, run by the project owner:**
  `node apps/api/scripts/verify-ws.js` confirmed a real job created
  through the public `/api/jobs` endpoint produces a real
  `job.updated` (status `COMPLETED`) broadcast received over `/ws`
  through nginx. One real bug in the verification script was found and
  fixed here too (it read the wrong field name from the job-creation
  response) -- the WebSocket/broadcaster path itself needed no changes.

**What this is not, yet:** this is local validation against Docker
Desktop, not a public deployment. Nothing above is reachable from the
internet, there is no real domain, and no TLS certificate has been
issued. This document will be updated with a real URL the moment one
exists, and not before. Reaching that point still requires the same
external blocker as before: a VPS/cloud provider account and a domain
the project owner controls, neither of which can be supplied from this
session -- see "What's actually required to complete this" below.

**Known limitation carried forward from local validation, not yet
re-verified against this topology:** the API key used during this
local validation round is a real, working credential that has now
passed through chat/logs and must be treated as compromised for
production purposes. **It must be rotated (a new, never-shared value
set for `API_KEY` and `infra/.env.production`'s equivalent) before any
real public deployment.** See "API key setup and rotation" below.

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

## Migration procedure

Schema changes live as plain, additive SQL files in
`infra/migrations/*.sql` (renamed from `infra/init-db/` in Phase 17 --
same files, new name reflecting what they actually are now). They are
applied by `apps/api/src/scripts/migrate.ts`, a small, project-owned
runner -- not a new ORM/framework dependency. See that file's own
header comment for the full design rationale; in short:

- A `schema_migrations` ledger table records which files have been
  applied and when.
- Files are applied in filename order, each inside its own
  transaction; a failing file stops the run immediately (nothing later
  is attempted) and the process exits non-zero.
- A Postgres advisory lock serializes concurrent runs against the same
  database.
- It is idempotent and safe to re-run: already-applied files are
  skipped via the ledger, and every migration file this project has
  today is additionally defensive on its own (`CREATE TABLE IF NOT
  EXISTS` / `ADD COLUMN IF NOT EXISTS`).

**In production** (`infra/docker-compose.prod.yml`): a `migrate`
service runs this automatically, reusing the `api` image with its
command overridden to `node dist/scripts/migrate.js`. `api` and
`worker` both declare `depends_on: migrate: condition:
service_completed_successfully`, so neither one can start against a
database that hasn't had pending migrations applied. A redeploy
(`docker compose -f infra/docker-compose.prod.yml up -d --build`)
re-runs `migrate` fresh every time; if there is nothing new to apply it
exits 0 immediately.

**Adding a new migration:** drop a new `NNN_description.sql` file into
`infra/migrations/` (next number after the highest existing one) and
redeploy. Nothing else needs to change -- no code references the
specific file list.

**Why this replaced the previous mechanism:** the original approach
mounted `infra/init-db/` at Postgres's own
`docker-entrypoint-initdb.d`, which only ever runs once, against an
empty data volume. Every deployment after the first would have
silently never applied a newly added file. This is not a theoretical
concern -- it already happened twice in this project's own history
(see `docs/database.md`'s Phase 6 and Phase 10 entries, where the
schema change had to be applied by hand against the live database
because nothing else would have run it).

**Verified so far:** the runner's connect-and-fail-fast behavior (no
`DATABASE_URL` -> exits 1 with a clear message; unreachable database ->
exits 1 with the real connection error) and its default migrations-
directory path resolution were verified for real from this session.
Actually applying it against a real database -- both a fresh one and
an already-populated one -- has not yet been done from this session
(no reachable Postgres here; see `docs/engineering-decisions.md`).
**Exact commands to verify this yourself:**

```
# Fresh-volume case (new deployment):
docker compose -f infra/docker-compose.prod.yml up -d
docker compose -f infra/docker-compose.prod.yml logs migrate
# Expect: "Applying 3 pending migration(s)" then "Applied 001_...",
# "Applied 002_...", "Applied 003_...", then "All migrations applied".

# Existing-volume case (this is the case that used to silently break):
# with the stack already up and initialized, add a harmless no-op
# migration file, e.g. infra/migrations/004_test_noop.sql containing
# just `SELECT 1;`, then:
docker compose -f infra/docker-compose.prod.yml up -d --build migrate
docker compose -f infra/docker-compose.prod.yml logs migrate
# Expect: "Applying 1 pending migration(s)" / "Applied 004_test_noop.sql"
# -- proving a migration added after the volume already had data was
# picked up and applied, which the old mechanism could never do.
# Then delete that test file (or leave it -- it's harmless and
# idempotent either way) and re-run to confirm it reports
# "Database already up to date".
```

## Startup procedure

```
cd infra
# Fill in infra/.env.production from infra/.env.production.example first.
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f migrate api worker dashboard
```

Startup order is enforced by Compose's `depends_on` conditions, not by
hoping: `postgres`/`rabbitmq` must report healthy before `migrate`
runs; `migrate` must exit 0 before `api`/`worker` start; `dashboard`
has no database dependency and starts independently (it only needs
`api` to be *starting*, not fully ready, since nginx will simply return
an upstream error for `/api/*` until `api` itself is ready -- the
static SPA shell still loads).

## Health checks

- `GET /api/health` -- liveness. Is the API process itself running?
  Used by the `api` container's own `HEALTHCHECK` and safe to poll
  frequently.
- `GET /api/health/ready` -- readiness. Are Postgres and RabbitMQ both
  currently reachable? Returns 503 (not 200) if either is down -- see
  `docs/failure-handling.md` for why liveness and readiness are
  deliberately different checks (Incident 5).
- Both are reachable through the public entry point at
  `<dashboard-origin>/api/health` and `<dashboard-origin>/api/health/ready`
  (nginx reverse-proxies them, same as every other `/api/*` route).

## API key setup and rotation

- Generate a real key with a real source of randomness, e.g.:
  `openssl rand -hex 32` (or `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
  if `openssl` isn't available).
- Set it as `API_KEY` in `infra/.env.production` (never committed --
  see `.gitignore`). The API refuses to start in production without it
  (`apps/api/src/config/env.ts`).
- The dashboard never stores this key anywhere persistent on its own:
  the operator enters it once per browser tab via a prompt, held only
  in `sessionStorage` (see `docs/security.md`). There is nothing to
  update on the frontend when the key rotates.
- **To rotate:** set a new value for `API_KEY` in
  `infra/.env.production`, then `docker compose -f
  docker-compose.prod.yml up -d api` to restart just the `api`
  container with the new value. The old key stops working immediately
  (there is no grace period/overlap -- a single shared secret, by
  design, has no concept of two simultaneously valid keys). Any
  operator with the dashboard open will need to re-enter the new key
  on their next mutating action (the 401 response already triggers
  this -- see `apps/dashboard/src/components/JobDetail.tsx`).
- **Rotate immediately if a key is ever exposed** (shared in chat,
  logs, a screenshot, committed by accident, etc.) -- exactly the
  situation from this project's own Phase 17 local validation round,
  where the key used has been exposed and must be treated as
  compromised. It was never a production deployment's key (no public
  deployment has happened yet), but the same rotation step applies
  before any real deployment uses it.

## Rollback considerations

- **Application code:** `docker compose -f docker-compose.prod.yml up
  -d --build` with a previous Git commit checked out rebuilds and
  restarts `api`/`worker`/`dashboard`/`migrate` from that commit.
  Standard Docker Compose redeploy, nothing project-specific.
- **Schema:** this project's migration runner is deliberately
  forward-only (see its header comment and `docs/engineering-
  decisions.md` -- no down-migrations, matching the "smallest thing
  that solves a demonstrated problem" scope this project holds itself
  to). Every migration so far is additive (new table, new
  nullable/defaulted column) and safe to leave in place even if the
  application code that used a new column is rolled back -- an unused
  extra column is harmless. A rollback that needed to actually remove
  a column or table would be a manual, deliberate `psql` operation
  against the live database, not something this runner automates; none
  of this project's migrations have needed that yet.
- **Data:** `postgres_data`/`rabbitmq_data` are named Docker volumes,
  never deleted by any command in this project's documented procedures
  (`stop`/`start`/`up -d`/`up -d --build` all leave volumes untouched;
  only an explicit `docker compose down -v`, which nothing here ever
  instructs running against a real deployment, would remove them). A
  real backup/restore procedure for `postgres_data` (e.g. `pg_dump` on
  a schedule) has not been built -- this is a genuine, named gap for a
  real production deployment, not something to claim is handled.

## Verification scripts (Phase 17)

Three scripts, all under `apps/api/scripts/`, written to be run against
a real running `docker-compose.prod.yml` stack. Each is self-contained
(plain Node, using only dependencies already installed for `apps/api`)
and prints real pass/fail evidence rather than assuming success.
`verify-ws.js` and `verify-chaos.js` have both now been run for real by
the project owner against the real stack and passed (after fixing real
bugs found in the scripts themselves -- see below and
`docs/development-log.md`'s Phase 17 entry). `verify-latency.js` has
not yet been run for real by anyone -- its numbers, when it is run,
should be treated as the first real measurement, not compared against
any prior claim (none exists). None of the three could be executed
from THIS session specifically -- no Docker/reachable Postgres/
RabbitMQ here, see `docs/engineering-decisions.md`.

```
DASHBOARD_URL=http://localhost:8080 API_KEY=<real key> node apps/api/scripts/verify-ws.js
DASHBOARD_URL=http://localhost:8080 API_KEY=<real key> node apps/api/scripts/verify-latency.js
DASHBOARD_URL=http://localhost:8080 API_KEY=<real key> node apps/api/scripts/verify-chaos.js
```

- `verify-ws.js`: opens a real WebSocket to `/ws` through nginx,
  creates a real job through the same public origin, and asserts a
  real `job.updated` broadcast is received for that exact job ID.
- `verify-latency.js`: measures real, repeated request latency
  (default 50 requests per path) for the liveness endpoint, the
  readiness endpoint, and authenticated job creation, all through the
  public nginx path; reports p50/p95/p99. Optionally compares against
  a direct-to-`api` path if `API_DIRECT_URL` is set (e.g. a
  temporarily published `api` port).
- `verify-chaos.js`: stops `postgres` (via `docker compose stop`,
  never touching the volume), confirms liveness stays up and readiness
  correctly reports the failure, restarts it, confirms readiness
  recovers, then submits a real job and confirms the worker actually
  processes it to completion -- then repeats the same sequence for
  `rabbitmq`. Aborts immediately, before touching anything, if the
  stack isn't already healthy at baseline. **Requires the same
  `--env-file` the stack was started with** (defaults to
  `infra/.env.production`, override with `ENV_FILE=<path>`) -- a real
  run without it found that `docker compose stop/start` cannot resolve
  this project's required interpolated variables and fails before
  touching any container, which (before this was fixed) let later
  "recovers" assertions report PASS even though nothing had actually
  gone down. The script now aborts immediately, with a clear message,
  if `ENV_FILE` doesn't exist or if `docker compose ... config --quiet`
  can't resolve the configuration -- and each service's "recovers"
  assertion can only pass if the outage was genuinely observed first.

Each script's own header comment has the full usage details and exact
copy-paste commands.
