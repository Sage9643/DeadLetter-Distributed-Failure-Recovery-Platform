# DeadLetter

[![CI](https://github.com/Sage9643/DeadLetter-Distributed-Failure-Recovery-Platform/actions/workflows/ci.yml/badge.svg)](https://github.com/Sage9643/DeadLetter-Distributed-Failure-Recovery-Platform/actions/workflows/ci.yml)

Distributed Failure Capture, Recovery & Event Replay Platform.

Status: Phase 15 — PostgreSQL connection resilience & worker DB-error
backoff, implemented and validated by a real, sustained PostgreSQL
outage against the actual Docker Compose stack (worker not restarted,
backoff observed progressing 1s -> 2s -> 4s -> 8s -> 16s -> 30s capped,
job completed successfully on recovery), and confirmed by a real Jest
run (API 19/19 suites/84/84 tests, Worker 6/6 suites/23/23 tests --
see `docs/development-log.md` for the full, honest validation status).
Phase 14's RabbitMQ connection recovery remains validated against a
real RabbitMQ outage on the real Docker Compose stack. See
`docs/development-log.md` for the full phase-by-phase history and
`docs/architecture.md` for the current system design.
