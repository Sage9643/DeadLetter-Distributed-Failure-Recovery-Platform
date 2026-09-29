# DeadLetter

[![CI](https://github.com/Sage9643/DeadLetter-Distributed-Failure-Recovery-Platform/actions/workflows/ci.yml/badge.svg)](https://github.com/Sage9643/DeadLetter-Distributed-Failure-Recovery-Platform/actions/workflows/ci.yml)

Distributed Failure Capture, Recovery & Event Replay Platform.

Status: Phase 17 — production containerization, security baseline,
and migration runner validated end-to-end against a real Docker Compose
production stack (`infra/docker-compose.prod.yml`) on the project
owner's own machine: all containers healthy, nginx correctly proxying
`/api` and `/ws` to the API behind the dashboard's single public port,
API-key auth confirmed (401 without a key), and a real job completing
end-to-end (API -> Postgres/outbox -> RabbitMQ -> worker -> Postgres).
**Not yet deployed to the public internet** -- this is local validation
of the production topology, not a live URL; see `docs/deployment.md`
for exactly what that still requires. Phase 15's PostgreSQL/RabbitMQ
chaos resilience and Phase 14's RabbitMQ connection recovery remain
validated against real outages. See `docs/development-log.md` for the
full phase-by-phase history, `docs/architecture.md` for the current
system design, `docs/security.md` for the security baseline, and
`docs/deployment.md` for the deployment/migration procedure.
