# ADR-0002 — libSQL/SQLite storage, forward-only migrations, Drizzle mirror

- **Status:** Accepted (Phase 1)
- **Related:** roadmap §3.3, §4.2, §4.4.1, I7, I11; gates 1.1, 1.14, 1.16
- **Supersedes:** nothing
- **Superseded by:** nothing

## Context

The engine needs a local store that:

- survives a crash mid-checkpoint without leaving a half-visible state;
- supports a single writer with fast point reads on `(project_id, branch, path)`;
- ships without a compiler toolchain on the user's machine;
- can later sync between devices without making a local history rewrite visible as truth.

The Phase 0 install probe required a prebuilt artifact and forbade install-time builds. The engine also needs the schema to be reviewable as SQL, not only as ORM calls, because the DDL is the contract that migrations and parity tests both target.

## Decision

1. **libSQL via `@libsql/client`** as the storage backend, in local-file mode. It ships a prebuilt platform binary (Rust binding), so there is **no compiler and no build step**; this ADR does not claim "zero native code".
2. **WAL with `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`.** A database that cannot enter WAL mode is refused with `UNSAFE_FILESYSTEM`, because a WAL database on a synced or network filesystem is a corruption generator, not a degraded mode.
3. **All statement dispatch is serialised through one mutex in `db/client.ts`.** This is a measured requirement, not a style choice: libSQL's local client services concurrent `execute` calls on more than one underlying connection, and connection-scoped pragmas are not shared. A concurrent probe observed `busy_timeout` reset to `0`, putting `foreign_keys` at the same risk. One writer is already the architecture (ADR-0001), so serialisation costs nothing real. `withTx` opens `client.transaction("write")`, which the client maps to `BEGIN IMMEDIATE`; that is the allocation boundary D1 requires.
4. **The DDL is normative and migrations are forward-only.** `PRAGMA user_version` is the only migration bookkeeping; there is no second table to drift. Each migration runs inside one transaction, so a failure leaves the schema at its previous level rather than half-applied. Downgrades are refused, not "best effort".
5. **`schema.ts` is a Drizzle mirror, and a parity test is a gate.** Drizzle is used for typed queries, not to generate the schema. Gate 1.1 compares `PRAGMA table_info` against the mirror (names, types, nullability, primary keys, default presence) and asserts that the Drizzle table set equals the DDL table set. The FTS5 virtual table is named as an explicit exclusion so it cannot disappear silently.
6. **Sync is decided here and implemented in Phase 4.** Device sync uses Turso/libSQL replication at the storage layer, but correctness is enforced above it by `content_root` and the auto-fork rule (ADR-0011). No component may treat replication as conflict resolution.

## Consequences

- `shared-types` stays dependency-free; storage dependencies live only in `core-engine`.
- Query code is typed end-to-end without a code-generation step, and the SQL remains reviewable in `migrations/`.
- A future move to `node:sqlite` (if Node 24 becomes the floor) is a backend swap behind the existing client interface, not a schema change.
- Serialising dispatch means a long analytical query will delay a short write; that is acceptable for v1 and is visible in `chronos doctor` latency, rather than hidden in a second connection with different pragmas.
- `state_nodes_full` is a view over `state_nodes ⋈ node_versions`; content is stored once, in the version ledger, and a head row never duplicates it.

## Alternatives considered

- **`better-sqlite3`.** Rejected: native build at install time (violates the install contract) and synchronous API that would block the daemon's HTTP loop.
- **`node:sqlite`.** Deferred: requires a newer Node floor than 22.15 and would narrow the supported matrix. The client interface keeps this door open.
- **Drizzle-kit as the migration source of truth.** Rejected: the roadmap's DDL includes views, FTS5, partial CHECK constraints and STRICT tables that an ORM generator does not express faithfully; the parity test is a stronger contract than generation.
- **A `_migrations` table.** Rejected: two sources of truth for "what schema is live". `user_version` is atomic with the migration transaction.
- **Per-call connections so each one can set its own pragmas.** Rejected: opening a connection per call loses the prepared-statement cache and makes WAL checkpointing noisier, while still not solving cross-statement transactions.
