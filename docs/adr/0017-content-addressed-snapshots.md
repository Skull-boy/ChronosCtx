# ADR-0017 — Content-addressed snapshots with schema-level dedupe

- **Status:** Accepted (Phase 1)
- **Related:** roadmap §4.2 `snapshots`, §4.2.1, §7 D5, I7, I11; gates 1.9, 1.10, 4.x
- **Supersedes:** nothing
- **Superseded by:** nothing

## Context

Checkpoints are cheap only if identical states are stored once. Two different questions have to be answered, and conflating them breaks sync:

1. **"Is this the same local state as that checkpoint?"** The state is a map `path → version_id`. Equal maps mean a rewind is a pointer move inside one database.
2. **"Does this device hold the same knowledge as that device?"** The same decision written independently on two machines has different `version_id`s but identical `content_hash`es.

A single hash cannot answer both: hashing `version_id`s is local by construction, and hashing content only would collapse two genuinely distinct local histories into one row and break rollback.

## Decision

1. **Two identities are computed and stored for every snapshot:**
   - `snapshot_hash = sha256("chronos-snapshot-v1\n" + sorted("path\0version_id" lines))` — exact **local** state identity;
   - `content_root = sha256("chronos-content-root-v1\n" + sorted("path\0content_hash" lines))` — **portable** knowledge identity.
2. **Dedupe is in the schema:** `UNIQUE (project_id, snapshot_hash, kind)` plus `INSERT … ON CONFLICT DO NOTHING`. Two checkpoints with the same state share one immutable row; the second insert writes zero bytes.
3. **Snapshot rows are immutable.** No update statement targets `snapshots`; a changed state is a new row. `body_zstd` stores the canonical sorted `path\0version_id` lines, so a snapshot can be re-read without the live tables.
4. **`kind` is part of the identity.** v1 supports `state` only; trees live in git/manifest and are referenced by checkpoints, so a state snapshot is never confused with a file snapshot.
5. **`content_root` is indexed** (`idx_snap_content`) and is the identity sync compares (ADR-0011). A differing `snapshot_hash` with an equal `content_root` is identical knowledge written twice — no conflict, no branch.
6. **Dedupe is observable, not assumed.** `chronos stats --dedupe` reports rows written vs checkpoint count, and gate 1.9 asserts that 200 checkpoints over 3 distinct states produce exactly 3 rows.
7. **Identity hashing is versioned.** The prefixes (`chronos-snapshot-v1`, `chronos-content-root-v1`) are part of the hash input, so a future encoding change is a new version rather than a silent redefinition of existing hashes.

## Consequences

- Gate 1.10 is a deliberate two-row test: states differing only in `version_id` share `content_root` but produce two snapshot rows. That proves local rollback is not collapsed by cross-device equivalence.
- A device that rewrites the same decision produces a different `snapshot_hash` but the same `content_root`; sync can dedupe bytes without claiming histories are equal.
- Because `content_hash` covers title, summary and content (ADR-0005), a label edit also changes `content_root`. That is deliberate: the summary is model-visible, so two devices rendering different summaries do not hold identical knowledge. A future label-only exemption requires a separate body hash and an ADR amendment.
- `node_count` and `bytes` are stored for cheap `chronos stats` and retention decisions, and are validated against the decoded body.
- Deleting a snapshot is not required for correctness in v1; retention acts on checkpoints and orphan cleanup, never on a row a checkpoint still references.

## Alternatives considered

- **One hash over content only.** Rejected: two distinct local states with the same knowledge collapse into one row, and a rollback to "version 3" becomes impossible to represent.
- **One hash over `version_id` only.** Rejected: two devices that independently wrote the same decision look divergent, producing false sync conflicts.
- **Dedupe in application code with a SELECT-then-INSERT.** Rejected: it races under the single writer's own retries and makes correctness depend on remembering the check. `UNIQUE` + `ON CONFLICT` is enforced by the database.
- **Compress with a custom delta format.** Rejected for v1: zstd over a canonical sorted body is simple, verifiable, and dedupe already removes the repeated case entirely.
