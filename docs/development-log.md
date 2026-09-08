# Development Log

## Phase 0 — Repository Foundation & Infrastructure Setup

**Date:** 2026-09-08

### What we built
- Initialized Git repository with monorepo folder structure
  (apps/api, apps/worker, apps/dashboard, packages/shared, infra, docs, tests)
- Created `infra/docker-compose.yml` defining PostgreSQL 16 and RabbitMQ 3.13
  (management edition) with healthchecks and named volumes
- Brought up both services locally and verified them independently

### Why
Infrastructure must exist and be verified before any application code is
written against it. Building the API or worker first would mean writing
code against assumed behavior rather than a real, running dependency.

### Verification performed
- `docker compose ps` — both containers reached `healthy` status
- PostgreSQL: ran `SELECT version();` inside the container via
  `docker exec`, confirmed PostgreSQL 16.15 responding, correct database
  (`deadletter`) and user (`deadletter`) from compose env vars
- RabbitMQ: logged into management UI at `localhost:15672` as user
  `deadletter`, confirmed dashboard loads, 0 queues/connections/consumers
  as expected (nothing has connected yet)

### Problems encountered
1. **Docker Desktop not running** — `docker compose up` failed with a
   `npipe` connection error. Cause: Docker Desktop application (the GUI)
   was not started, even though the Docker CLI was installed and
   `docker --version` succeeded. Fix: started Docker Desktop manually,
   waited for it to report "running," retried successfully.
2. **Folder path had spaces and an em dash** (original folder name:
   `DeadLetter — Distributed Failure Recovery Platform`). Renamed to
   `deadletter` early, before Docker Compose was introduced, to avoid
   path-related issues with future shell scripts and CLI tools.
3. **`ren` failed on first attempt** with "process cannot access the file"
   — caused by another process (editor/explorer window) holding a handle
   on a file in the folder. Resolved by closing other windows referencing
   the folder before retrying.

### Tests performed
- Manual verification only (see above). No automated tests yet — nothing
  to automate at this stage.

### What remains to be tested
- API/worker actually connecting to these services (Phase 1+)
- Behavior when either service is unavailable (deferred — chaos testing
  is Phase 11)

### New risks introduced
- None yet; infrastructure only, no logic.

### What we learned
- Docker Desktop must be fully running (not just installed) before
  `docker compose` commands will work — the CLI existing is not sufficient.
- Verifying "healthy" status alone isn't enough proof of correctness;
  actually querying Postgres and logging into RabbitMQ's UI confirmed the
  environment variables (user/db/password) were genuinely applied, not
  just that containers started.

## Phase 0 — API Project Scaffolding

**Date:** 2026-09-08

### What we built
- Initialized `apps/api` as an npm workspace member with its own `package.json`
- Installed TypeScript and `@types/node` as devDependencies (hoisted to root
  `node_modules` via npm workspaces)
- Generated and configured `tsconfig.json`: set `rootDir`/`outDir` for a
  proper src → dist compile boundary, and fixed `types` to include `"node"`
  so global Node types (`process`, `Buffer`, etc.) are actually available
- Verified the full TypeScript → JavaScript → Node pipeline works with a
  trivial `console.log` entry point compiled via `tsc` and run via `node`
- Added `build`/`start`/`dev` npm scripts to `apps/api/package.json`

### Why
Scaffolding must be provably working before any real code is written on
top of it — a broken compile step discovered after 500 lines of business
logic is much more expensive to debug than one discovered now, with a
one-line file.

### Problems encountered
1. **Misplaced files from an early `cd` error** — after `npm init -y`
   inside `apps/api`, two `cd ..` commands were run in a row before the
   next commands, landing at the repo root instead of `apps/api`.
   `npm install`, `tsc --init`, and file creation all happened one level
   too high, polluting the repo root with `node_modules`, `tsconfig.json`,
   and `src/`, and modifying the root workspaces `package.json` with an
   unwanted `devDependencies` field.
   **Fix:** deleted the misplaced files/folders, restored the root
   `package.json` to its original clean content, and re-ran the same
   commands from the correct directory (`apps/api`) this time.
2. **`node_modules` and `package-lock.json` reappeared at the repo root
   after installing from inside `apps/api`** — initially looked identical
   to problem #1. Verified this was actually correct npm workspaces
   behavior (dependency hoisting to a single root `node_modules`/lockfile
   across all workspace members), not a repeat mistake, by confirming
   `typescript`/`@types/node` were correctly recorded under
   `apps/api/package.json`'s `devDependencies` and the root `package.json`
   was untouched.
3. **`tsc --init` defaults were not directly usable**: `rootDir`/`outDir`
   were commented out (no defined src → dist boundary), and `"types": []`
   explicitly excluded Node's global types despite `@types/node` being
   installed. Both were fixed manually before the build was verified.

### Tests performed
- `npx tsc` — compiled with no errors
- `node dist/index.js` — printed expected output, confirming the compiled
  output is actually runnable
- `npm run dev` — confirmed the convenience script produces the same
  result as running the two commands manually

### What remains to be tested
- No real application logic yet — this only proves the toolchain works

### New risks introduced
- None; scaffolding only

### What we learned
- npm workspaces hoist dependencies to a single root `node_modules` and
  `package-lock.json` by default — a workspace member's own
  `node_modules` folder not existing locally is expected, not a bug, as
  long as the dependency is correctly recorded in that member's own
  `package.json`
- `tsc --init`'s generated config is not immediately usable as-is for a
  Node project — `rootDir`/`outDir` and the `types` array need explicit
  configuration