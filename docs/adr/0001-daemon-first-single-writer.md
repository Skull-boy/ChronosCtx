# ADR-0001 — Daemon-first, single-writer engine with a stdio proxy

- **Status:** Accepted (Phase 1)
- **Related:** roadmap §2.1–§2.3, §2.9, §2.11, I8, §7.1 F1; gates 1.13, 2.13
- **Supersedes:** nothing
- **Superseded by:** nothing

## Context

An LLM harness (OpenCode, Claude Code, Cursor, Cline, …) starts and stops a child process for every session, sometimes several at once. A web bridge runs independently of any harness. If each surface opened the SQLite database itself, then:

- two surfaces could allocate the same node version concurrently;
- connection-scoped pragmas (`foreign_keys`, `busy_timeout`) would be set by whoever connected last;
- rewind could restore files while another process was mid-commit;
- there would be no place to hold a branch write lease.

Phase 0 also showed the cost of an extra process is measurable (spawn floor 73 ms on the Windows host), so the topology cannot be "one daemon per surface".

## Decision

1. **One engine process per user, per machine** owns the database, the object store, and the watcher. It binds loopback HTTP on a port from 4870–4899 (4872 reserved) and writes `run/daemon.json` for discovery.
2. **Every MCP surface is a thin stdio proxy.** It speaks MCP on stdio and forwards `tools/call` to the daemon over loopback with a bearer token. It holds no durable state and opens no database connection.
3. **The daemon is the only writer.** All writes go through one serialised request path; SQLite's WAL mode is a durability mechanism here, not a concurrency mechanism between clients.
4. **Contention is named, not hidden.** A second writer that needs a busy branch receives `PROJECT_BUSY` with `retriable: true` and a retry hint; a write during rewind receives `WRITE_REJECTED_BRANCH_QUIESCED`. Neither is silently queued behind a lock with no timeout.
5. **Degrade explicitly when a daemon is impossible** (locked-down CI, read-only `CHRONOS_HOME`, no free port): the proxy may host the engine in-process, still as the single writer, and reports `DAEMON_UNAVAILABLE` for capabilities that need a second client (web bridge, watch). It never pretends those features work.

## Consequences

- The engine's concurrency model is simple enough to test: one writer, serialised statements, immediate transactions.
- The stdio proxy must be cheap to start and must not buffer responses in a way that breaks streaming; its cold path is a gate.
- A daemon crash is a first-class failure mode, so the reconciler (`STALE_QUIESCE`, journal replay) is Phase 2 work, not an afterthought.
- Multi-user and multi-machine access are additive later (`owner_id`, per-device tokens, sync) because the writer boundary is already a process boundary.
- `chronos daemon start|stop|status|logs` and `chronos doctor` are required deliverables, not conveniences.

## Alternatives considered

- **Library-only engine, database opened per surface.** Rejected: it moves every invariant (version allocation, lease, quiesce) into every host process, and there is no place to serialise them. It also makes rewind racing a commit a real possibility rather than a refused request.
- **One daemon per project.** Rejected: a user with ten projects gets ten processes and ten port allocations for one SQLite file; `CHRONOS_HOME` is deliberately global.
- **Daemon over a Unix socket only.** Rejected as the sole transport: named pipes/Unix sockets are faster but the extension and web bridge need HTTP anyway, and a second transport doubles the security surface. IPC is used for the local proxy fast path and loopback HTTP remains the contract.
- **Trust `SQLITE_BUSY` retries instead of a lease.** Rejected: a retry loop around a multi-statement commit cannot preserve the "one checkpoint is one transaction" guarantee (ADR-0018) without an application-level lease.
