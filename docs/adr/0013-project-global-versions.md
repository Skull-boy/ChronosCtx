# ADR-0013 — Project-global version semantics and fork lineage

- **Status:** Accepted (Phase 1)
- **Related:** roadmap §4.1, §4.2, §7 D1; gates 1.3, 1.11, 2.6
- **Supersedes:** nothing
- **Superseded by:** nothing

## Context

A node path can exist on several branches at once. `version` has to answer "which revision of this path is this?" in a way that survives forks, merges and devices. Three counters are tempting and all fail:

- **branch-local** counters produce two `v5` rows for one `(project_id, node_path)` when branches merge;
- **per-session** counters are meaningless after a restart and collide across surfaces;
- **timestamp-derived** versions are non-deterministic and can collide within a millisecond.

The database also needs a uniqueness constraint that is actually enforceable, not a convention.

## Decision

1. **`version` is project-global per `(project_id, node_path)`.** Allocation is `max(version)+1` computed inside a `BEGIN IMMEDIATE` transaction, and `UNIQUE (project_id, node_path, version)` enforces it.
2. **Forks share the sequence.** A branch forked at `v4` edits to `v5`, `v6` while another branch edits to `v7`; there is no collision and gaps are legal.
3. **Provenance is carried, not inferred:** `created_on_branch` records where a version was written, and `forked_from_version_id` records lineage when a node is copied to a branch.
4. **Rewind never deletes versions.** History is append-only; a rewind moves heads and marks checkpoints aborted, but the version rows remain.
5. **Lineage rendering is deterministic:** a node's ancestry is walked through `supersedes_version_id` and `forked_from_version_id`, ordered by `version`, and rendered without timestamps. This is what makes a fork comparison reproducible.
6. **`expected_version` is optimistic concurrency.** A commit that supplies it and loses the race receives `VERSION_CONFLICT` with the current version and `content_hash`, and **no write** occurs.
7. **Rename preserves lineage.** A path change writes a `node_aliases` row and a new version whose `supersedes_version_id` points at the old head; it does not create an unrelated node.

## Consequences

- Merging cannot collide on `(path, version)`; the worst case is a gap, which is visible and harmless.
- A single database-wide sequence per path means two branches writing the same path interleave in one ordering, which is exactly what merge needs to compute ancestry.
- `VERSION_CONFLICT` is a normal, retriable-by-refresh outcome, not an internal error.
- Version numbers are not dense, so no code may assume `v(n-1)` exists.
- Alias resolution happens on read, so old links in a capsule or a bug report still resolve.

## Alternatives considered

- **Branch-local counters.** Rejected: they collide on merge and require a renumbering pass, which rewrites identifiers users may have cited.
- **UUID-only versions with no integer.** Rejected: an integer is useful for humans and for capsule text (`jwt-spec@v3`), and the integer can be deterministic while the id stays opaque.
- **Per-device counters with a device prefix.** Rejected: it makes the visible version number depend on which machine wrote last, which is unreadable in a capsule.
- **Deleting versions on rewind.** Rejected: destroys auditability and breaks any citation of an old version.
