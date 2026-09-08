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