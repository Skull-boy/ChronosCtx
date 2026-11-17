# ADR-0003 — ULID identifiers with typed prefixes

- **Status:** Accepted (Phase 1)
- **Related:** roadmap §4.1, I7; gates 1.2, 1.10, 3.12
- **Supersedes:** nothing
- **Superseded by:** nothing

## Context

Identifiers cross every boundary: MCP payloads, SQLite rows, capsule text, sync payloads, and log lines. They need to be:

- generated without a central authority or a network call;
- sortable by creation time for index building and for `ORDER BY` on history;
- self-describing enough that a model reading a payload does not confuse `prj_…` with `nod_…`;
- reproducible in tests, because several gates compare rendered output byte-for-byte.

The project also refuses to add a dependency for this: `ulid` is one package, but the factory needs a seeded mode and a monotonic overflow rule that an off-the-shelf package does not expose.

## Decision

1. **Format:** `<prefix>_<26-char Crockford base32 ULID>`, e.g. `nod_01JBQ4P8Z6K2V9T3R5X7C1N0DA`. The ULID is 48 bits of millisecond timestamp followed by 80 bits of randomness.
2. **Fifteen prefixes** are normative: `prj`, `brn`, `nod`, `ver`, `chk`, `nc`, `vev`, `rwd`, `snp`, `edg`, `ses`, `sfe`, `cap`, `prp`, `dev`. A prefix outside this set is a malformed id, not a new entity type.
3. **Monotonic within a process.** Two calls in the same millisecond increment the random component instead of drawing a new one, so ordering is preserved under a coarse clock. On 80-bit overflow the timestamp advances by one millisecond and a fresh random value is drawn.
4. **Deterministic mode for tests and reproducible artifacts.** `CHRONOS_DETERMINISTIC=1` (or an explicit injected clock/random source) fixes the clock to a constant and uses a seeded mulberry32 source. Production never sets it.
5. **Generation is injected, never imported directly by feature code.** Repositories take an `IdGenerator`; this is what makes the fork/version property tests deterministic and what keeps ULIDs out of hash inputs by accident.
6. **Parsing is total and strict.** `isId`, `parseId` and `idTimestamp` reject Crockford-excluded letters (`I`, `L`, `O`, `U`), wrong lengths and unknown prefixes. Timestamps are recovered from the id for diagnostics; they are never used as a source of truth for ordering in the database.

## Consequences

- New rows sort by id without a separate sequence, which keeps boot index construction and `created_at DESC` queries cheap.
- Sync can merge id-sorted streams without clock agreement; the timestamp is informative, not authoritative.
- A malformed id is a `PATH_INVALID`-class refusal at the boundary, which is cheaper than discovering it during a foreign-key insert.
- The prefix is redundant with the table it lives in. That redundancy is deliberate: payloads are read by models and by humans, and the table name is not in the payload.
- Adding an entity type is an explicit union change in `shared-types`, so it cannot happen by accident in one package.

## Alternatives considered

- **UUIDv4.** Rejected: not sortable, 36 characters with hyphens, and no type signal.
- **UUIDv7.** Close, but 36 characters, no typed prefix, and the monotonic-within-millisecond guarantee would still be ours to implement.
- **`nanoid`.** Rejected: no timestamp, not sortable, and the collision argument for 21 characters is weaker than 80 bits of ULID randomness.
- **Database autoincrement integers.** Rejected: not portable across devices, leaks row counts, and breaks the "ids are generated before the transaction" pattern that keeps checkpoint assembly deterministic.
- **`ulid` package.** Rejected after Phase 0's dependency review: one more package, and its factory does not expose the seeded deterministic mode the gates need.
