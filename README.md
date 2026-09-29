# DeadLetter

[![CI](https://github.com/Sage9643/DeadLetter-Distributed-Failure-Recovery-Platform/actions/workflows/ci.yml/badge.svg)](https://github.com/Sage9643/DeadLetter-Distributed-Failure-Recovery-Platform/actions/workflows/ci.yml)

Distributed Failure Capture, Recovery & Event Replay Platform.

Status: Phase 14 — RabbitMQ connection recovery (resolves Incident
5/8), validated against a real RabbitMQ outage on the real Docker
Compose stack (neither the API nor the worker process was restarted).
See `docs/development-log.md` for the full phase-by-phase history and
`docs/architecture.md` for the current system design.
