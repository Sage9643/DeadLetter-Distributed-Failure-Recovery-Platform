# Security

This document describes DeadLetter's public-facing security baseline:
what is protected, how, and what is deliberately left out of scope for
a project at this size. It reflects the state added in the
Master Finalization effort ("Phase 16" in `development-log.md`) and is
maintained alongside the code it describes, not written once and
frozen.

## Threat model, stated plainly

DeadLetter is a portfolio/demo distributed-systems project, not a
multi-tenant SaaS product. There is exactly one trusted operator (the
project owner) and an otherwise-anonymous public that may view the
dashboard. There are no user accounts, no roles, no per-tenant data
isolation to enforce. The security baseline is sized to that reality:
protect the *mutating* surface from anonymous abuse and keep secrets
out of anywhere a client (browser, Git history, Docker image) could
read them. It deliberately does not implement a user/session/identity
platform, which would be solving a problem this project doesn't have.

## Authentication and authorization

- A single shared secret (`API_KEY`), compared by exact string match
  against the `x-api-key` request header. See
  `apps/api/src/middleware/auth.ts`.
- Applied ONLY to the two state-changing routes: `POST /api/jobs` and
  `POST /api/jobs/:id/replay` (see `apps/api/src/routes/jobs.ts`).
  Middleware order is `requireApiKey -> rate limiter -> backpressure
  -> handler`, so an unauthenticated request is rejected before it can
  consume rate-limit budget or trigger a backpressure-check query.
- All `GET` routes (`/api/jobs`, `/api/jobs/:id`, `/api/stats`,
  `/api/health*`) remain public and unauthenticated, by design: this
  is a publicly-viewable demo, and gating reads behind the same secret
  used for mutations would force that secret into the dashboard's
  browser bundle to render anything at all -- which the secrets rule
  below forbids.
- In development/test, an unset `API_KEY` makes `requireApiKey` a
  no-op (every request passes). This fallback is closed off in
  production: `config/env.ts` refuses to start
  (`process.exit(1)`) if `NODE_ENV=production` and `API_KEY` is unset,
  so a production deployment can never silently run with its mutating
  routes open to anyone.
- The dashboard never bakes the API key into its built JS bundle. The
  operator enters it at runtime (`window.prompt()`), it is held only
  in `sessionStorage` (cleared when the tab closes), and a 401
  response clears the stored key and prompts the operator to re-enter
  it. See `apps/dashboard/src/api/apiKey.ts` and
  `apps/dashboard/src/components/JobDetail.tsx`.

## CORS

- `apps/api/src/app.ts` uses the `cors` package with an explicit
  origin-allowlist callback (`env.CORS_ALLOWED_ORIGINS`, a
  comma-separated exact-origin list) -- never a wildcard (`"*"`).
  Requests with no `Origin` header (server-to-server calls, curl,
  same-origin browser requests) are always allowed; anything else must
  match the allowlist exactly.
- In local development, the dashboard reaches the API through the Vite
  dev proxy (same-origin from the browser's perspective), so
  `CORS_ALLOWED_ORIGINS` can stay unset and no cross-origin request is
  ever actually made.
- `config/env.ts`'s production fail-safe also requires
  `CORS_ALLOWED_ORIGINS` to be set before the API will start in
  production.

## Input validation and request limits

- `POST /api/jobs` and the `:id` path parameter on every route using
  it are validated with `zod` schemas (`validation/jobSchema.ts`)
  before touching the database; invalid input is rejected with `400`
  and never reaches a query.
- `express.json()` is configured with an explicit, documented size
  limit (`env.JSON_BODY_LIMIT`, default `100kb`) rather than relying
  on an implicit library default nobody chose.
- A token-bucket rate limiter (`middleware/rateLimiter.ts`, Phase 12)
  applies to the same two mutating routes the API key protects: 100
  requests / 60 seconds per client by default, configurable via
  `RATE_LIMIT_CAPACITY` / `RATE_LIMIT_WINDOW_SECONDS`. These are
  initial development defaults, not experimentally-tuned production
  capacity numbers -- see `docs/engineering-decisions.md`.
- A backpressure check (`middleware/backpressure.ts`, Phase 12)
  rejects new job creation with `503` when `pendingOutboxEvents`
  exceeds `BACKPRESSURE_THRESHOLD`, protecting the outbox dispatcher
  from unbounded queue growth under load.

## Rate limiting behind the production nginx proxy (found and fixed, Phase 17 final audit)

**The finding:** `middleware/rateLimiter.ts`'s `defaultIdentify()`
keys each client's token bucket by `req.ip`. Before this fix,
Express's `trust proxy` setting was `false` everywhere in this
codebase, a decision that was correct when written (Phase 12) but
predated Phase 16's `infra/docker-compose.prod.yml`, which puts
`dashboard`'s nginx in front of the API as the ONLY container with a
published host port, reverse-proxying `/api` to `api`
(`apps/dashboard/nginx.conf`). With `trust proxy: false`, every
request the `api` container saw in production arrived from ONE
constant source -- nginx's own container address, not the real
external client's -- so `defaultIdentify()`'s per-client bucketing
silently collapsed into a single shared bucket for all traffic
reaching these routes through the documented production entry point.

**Real impact, assessed precisely:** low for this project's actual
auth model, not zero. The two affected routes (`POST /api/jobs`,
`POST /api/jobs/:id/replay`) already require `requireApiKey`, and this
project has exactly one shared operator API key by design (see
"Authentication and authorization" above) -- there was no scenario
today where two genuinely different, independently-authenticated
callers existed to unfairly share a bucket. GET routes, which the
general public actually hits, are never rate-limited at all (also by
design). It was nonetheless a real, previously-uncaught bug: the
code's own stated invariant ("distinguishes clients by real IP") was
not actually true in the shipped production topology.

**The fix, applied:** `apps/api/src/app.ts` now calls
`app.set("trust proxy", TRUST_PROXY_HOPS)` with `TRUST_PROXY_HOPS = 1`
-- trusting exactly one reverse-proxy hop, immediately after
`export const app = express();`, before any middleware or route is
registered. `req.ip` now resolves from `X-Forwarded-For`'s entry as
reported by that one trusted hop, correctly distinguishing real
clients in production, while remaining unspoofable by anything that
isn't that one trusted hop.

**Why `1`, not `true`:** Express's `trust proxy: true` trusts an
UNBOUNDED chain of `X-Forwarded-For` entries -- correct only when
every hop between the real client and this process is a proxy you
control, a claim this project cannot make in general (a future cloud
load balancer or CDN placed in front of nginx would add a hop that
`true` would blindly trust just as much as nginx itself, and a longer
forged chain would still be believed). `trust proxy: 1` instead trusts
only the immediate connecting peer's word for the client address and
nothing earlier in any chain that peer forwards -- bounded, and an
exact match for this project's actual documented topology (exactly
one hop: nginx). A focused test
(`apps/api/src/__tests__/unit/trustProxy.test.ts`) proves this
boundedness directly: a request carrying a forged, multi-entry
`X-Forwarded-For` chain (simulating an attempt to inject fake upstream
hops) resolves to the entry the one trusted hop itself appended, not
an attacker-controlled earlier entry in the same header.

**Why this is safe specifically here, not in general:** `trust proxy`
changes a trust boundary. Getting it wrong on a deployment where the
API is directly reachable from untrusted networks would let any caller
spoof `req.ip` via `X-Forwarded-For` and bypass the rate limiter
entirely. It is safe in this project's production Compose topology
specifically because `api` has NO published host port at all (see
"Network exposure" below) -- the only thing that can ever be the "one
trusted hop" reaching `api`'s socket is `nginx` itself, on the
`internal` Docker network. In local dev/test (`npm run dev`, Jest),
nothing actually proxies requests to this process, so `req.ip` already
resolves directly to the real caller's socket address regardless of
this setting -- trusting a hop that never exists there has no effect.
If `api` is ever given a published port of its own, or an additional
proxy/load balancer/CDN is ever placed in front of nginx, this value
must be reconsidered -- see `apps/api/src/app.ts`'s own comment for
the same rationale kept next to the code it describes.

**Verification:** `apps/api/src/__tests__/unit/trustProxy.test.ts`
proves, against the real Express app (via `supertest`, no database
needed): (1) the real, exported `app` has `trust proxy` set to exactly
`1`, never `true`; (2) two distinct clients, each presented through
one trusted hop via a distinct `X-Forwarded-For` value, get separate
rate-limit buckets; (3) a forged, multi-entry `X-Forwarded-For` chain
cannot make an unbounded number of hops trusted -- only the value the
one trusted hop itself supplied is used. The pre-existing
`rateLimiter.test.ts`/`rateLimiter.concurrency.test.ts` unit suites,
which exercise the limiter directly against mock `req.ip` values and
never touch Express's trust-proxy resolution, were re-run unchanged
and still pass, confirming this fix did not alter the limiter's own
admission logic.

## Error handling

- A centralized 4-argument Express error handler is registered last in
  `apps/api/src/app.ts`, catching anything a route handler throws or
  rejects with that wasn't already handled locally.
- The full error (including stack trace) is always logged server-side
  via the structured logger (`req.log`/`logger`).
- The HTTP response itself never includes a stack trace, SQL detail,
  or internal file path in production -- only
  `{ "error": "Internal server error" }`. Outside production, a
  `detail` field with the raw error message is added, to keep local
  debugging convenient without weakening the production posture.

## WebSocket (`/ws`)

- The WebSocket server (`apps/api/src/ws/broadcaster.ts`,
  `apps/api/src/index.ts`) is push-only: it broadcasts `job.updated`
  events (the same job status information already public via
  `GET /api/jobs`) and never accepts or processes any message a client
  sends. There is no mutation surface to protect over this channel, so
  it carries no authentication and no per-origin restriction --
  equivalent in trust level to the public `GET` routes it mirrors.
- **Known, accepted limitation:** there is no per-IP connection cap or
  rate limit on new WebSocket connections. Each connection is cheap
  (added to an in-memory `Set`, no per-connection database or CPU
  work), so this is a low-severity gap, not an oversight -- but it is
  a real one, and would be the first thing to add if this ever saw
  genuine public traffic rather than portfolio/demo use. Recorded here
  rather than silently left out.

## Secrets

- No secret (API key, database password, RabbitMQ credentials) is
  ever committed to Git, baked into a Docker image, or baked into the
  dashboard's built JS bundle.
- `infra/docker-compose.prod.yml` reads every secret via Compose's
  `${VAR:?required}` interpolation syntax, which fails the compose run
  loudly if the variable is unset -- nothing has a hardcoded fallback.
  `infra/.env.production.example` documents every required variable
  without real values; the real `infra/.env.production` file is
  git-ignored (see `.gitignore`).
- `.env.example` files (API/worker/dashboard) document required
  variable names the same way, with placeholder/example values only.
- **Rotation (Phase 17):** the `API_KEY` used during the real local
  production-topology validation round has passed through chat and
  must be treated as compromised -- it is NOT safe to reuse for any
  real deployment. See `docs/deployment.md`'s "API key setup and
  rotation" section for the exact rotation procedure. This is a
  standing reminder, not a one-time note: any key that is ever
  exposed (chat, logs, a screenshot, an accidental commit) must be
  rotated before the next real deployment, the same way.
- `REPLAY_TEST_DELAY_MS` (see `apps/api/src/routes/jobs.ts`) is a
  TEST-ONLY artificial delay used to widen a race window for one
  specific concurrency test. It defaults to `0` (disabled) and is not
  set anywhere in `infra/docker-compose.prod.yml` -- confirmed by
  inspection during the Phase 17 security review. If it is ever set to
  a nonzero value outside a test run, the route logs a loud warning
  ("TEST-ONLY delay active. Do not use in production.") specifically
  so this cannot happen silently.

## Network exposure

- In `infra/docker-compose.prod.yml`, `postgres` and `rabbitmq`
  (including RabbitMQ's management UI) publish **no host ports at
  all** -- they are reachable only from other containers on the
  internal Compose network. The only service with a published host
  port is `dashboard` (nginx), which reverse-proxies `/api` and `/ws`
  to the `api` service by Docker Compose service name (see
  `apps/dashboard/nginx.conf`). This is the single public entry point
  into the whole stack.
- This is a configuration-level guarantee (there is nothing to
  misconfigure at the application layer to accidentally expose
  Postgres or RabbitMQ publicly), not something enforced only by
  convention.
- (Phase 17) The `migrate` service, added when the migration runner
  replaced the old init-only mechanism, also publishes no host port
  and sits on the same internal network -- it is a one-shot process
  that exits after applying pending migrations, not something that
  needs to be reachable from anywhere.
- Verified by inspection during the Phase 17 security review: every
  service block in `infra/docker-compose.prod.yml` was checked for a
  `ports:` key. Only `dashboard` has one.

## Container privileges and resource limits (found during the Phase 17 final audit)

- **Privileges, verified by inspection:** `apps/api/Dockerfile` and
  `apps/worker/Dockerfile` both explicitly run as `USER node` (the
  non-root user `node:22-alpine` already defines) -- neither the API
  nor the worker process runs as root inside its container. `postgres`
  and `rabbitmq` run as whatever non-root user their own upstream
  images default to (not overridden here, not audited further --
  standard, widely-used official images). The `dashboard` container's
  nginx master process runs as root by default (the standard
  `nginx:alpine` image behavior; its worker processes, which actually
  handle connections, drop to the `nginx` user) -- not overridden, and
  in line with how that image is normally run.
- **Resource limits: a real, currently-unaddressed gap.** No service
  in `infra/docker-compose.prod.yml` declares a `deploy.resources`
  block (or the older `mem_limit`/`cpus` Compose v2 fields) -- every
  container can consume unbounded host CPU/memory. On the
  single-VM/single-host shape this file already documents (no
  orchestrator, no claimed high availability), one runaway container
  (a memory leak, a pathological query, a burst of load) can starve
  every other container on the same host, including Postgres and
  RabbitMQ. This was not caught by any earlier phase and is not
  implemented -- a real gap for a genuine production deployment, not
  something to claim is handled. The fix is a `deploy.resources.limits`
  entry per service once real resource usage under load has actually
  been measured (guessing limits without measurement risks
  under-provisioning and causing the exact outages this project's
  resilience work is meant to survive) -- see
  `docs/deployment.md`'s "What's actually required to complete this"
  section.

## Logging

- Secrets (the API key, database/broker URLs with embedded
  credentials) are never logged. `middleware/auth.ts` logs only
  whether a provided key matched, never the key value itself.

## Dependency vulnerabilities (npm audit)

Real `npm audit` results from this repository (Phase 17 final audit),
distinguishing what actually reaches production from what doesn't --
per this project's rule against blindly running
`npm audit fix --force`, which can silently force semver-major
upgrades and break things for a vulnerability that may not even apply
to how this project uses the package:

- `npm audit --omit=dev` (production dependencies only -- what
  actually ships inside the Docker images described above): **0
  vulnerabilities** at any severity, across 122 production
  dependencies.
- `npm audit` (including devDependencies): 5 findings -- 1 critical,
  1 high, 3 moderate -- ALL in `vite`/`vitest`/`esbuild`/`vite-node`/
  `@vitest/mocker`, the dashboard's build and test tooling. None of
  these packages are installed in any production Docker image (each
  Dockerfile's production stage runs `npm install --omit=dev`) or
  shipped in the built static dashboard bundle (`vite build` output is
  plain HTML/JS/CSS with no bundler code included).
- **Why these are not treated as actionable right now:** every one of
  them describes an attack against a locally *running* Vite dev server
  or Vitest UI server being reached by an untrusted website or network
  peer (e.g. "esbuild enables any website to send any requests to the
  development server and read the response"). This project never runs
  a Vite dev server or Vitest UI server anywhere reachable from
  untrusted networks -- local development binds to localhost only, and
  CI (`.github/workflows/ci.yml`) runs `vitest run`/`tsc -b && vite
  build` headlessly, never as a listening server. The vulnerable code
  path does not execute in this project's actual usage.
- **Why not force-fixed anyway:** `npm audit`'s own `fixAvailable` for
  every one of these requires a semver-major bump (vitest 4->5, vite
  6->8, marked `isSemVerMajor: true`) -- exactly the kind of change
  `npm audit fix --force` would make unattended, and exactly the kind
  that deserves its own deliberate upgrade-and-retest pass (a major
  Vite/Vitest bump can change build output, config format, or plugin
  compatibility), not a reflexive fix applied during a security audit.
  This is a genuine, named, low-priority gap -- see
  `docs/development-log.md`'s Phase 17 entry -- not something claimed
  as resolved.

## Deliberately out of scope

Per this project's explicit anti-overengineering constraint, the
following are not implemented, and are not gaps to silently work
around later without a demonstrated need:

- Per-user accounts, sessions, JWTs, OAuth, or any multi-tenant
  identity model -- there is one operator, not many users.
- A web application firewall, DDoS mitigation service, or a
  reverse-proxy-level rate limiter in front of the application-level
  one already described above.
- Centralized secret management (Vault, cloud KMS, etc.) -- `.env`
  files plus Compose's `${VAR:?required}` fail-fast are the
  right-sized tool for a single-operator, single-region deployment.
