# ADR-0018 — Atomic checkpoint transaction and `snapshot_kind` semantics

- **Status:** Accepted (Phase 1)
- **Related:** roadmap §4.2 `checkpoints`, §2.5, §7 D6, I5; gates 2.3, 2.10, 2.11
- **Supersedes:** nothing
- **Superseded by:** nothing

## Context

A checkpoint is not a row; it is a claim that "these files and this reasoning state existed together". If the file tree is captured but the checkpoint row is lost, the user has storage with no address. If the row is written but the tree is missing, the timeline points at nothing and rewind silently does the wrong thing.

Phase 0's crash tests were run against the git recipe, not the DDL, so the transactional contract has to be stated independently of the storage backend.

## Decision

1. **One transaction, one visibility point.** In a single `BEGIN IMMEDIATE`: insert the snapshot row (`ON CONFLICT DO NOTHING`) → insert node versions → insert the checkpoint row → update `branches.head_checkpoint_id`. The database commit is the only moment the checkpoint becomes visible.
2. **`snapshot_kind` is a closed two-value union:**
   - `combined` — a file tree was captured; `storage` is `git` (with `git_tree_hash`) or `manifest` (with no git tree);
   - `state_only` — no files at all; `storage='none'` and `git_tree_hash IS NULL`, legal only for web-only surfaces.
   A `CHECK` constraint enforces exactly these combinations; there is no third possibility and no "unknown" state.
3. **A tree without a checkpoint row is not a checkpoint.** The shadow repo may hold an unreferenced tree after a crash; that is garbage, and `chronos gc` may prune it. It is never presented as history.
4. **A checkpoint row without its tree is impossible** for `combined`: the `CHECK` requires `git_tree_hash` or `storage='manifest'`, so a half-written row fails at insert.
5. **`alternates` records whether the shadow store shared objects** with the user's repo (1/0), so a later restore knows whether the tree can be resolved locally.
6. **Node versions are written before the checkpoint row**, so the snapshot body (`path\0version_id`) references rows that already exist and foreign keys hold inside the transaction.
7. **Aborted checkpoints are marked, not deleted.** `aborted=1` plus `aborted_by_rewind_id` preserves the audit trail; the head moves past them.
8. **`file_count` and `node_count` are denormalized counts validated against the snapshot body** when written; a mismatch is a bug, not a warning.

## Consequences

- Crash injection at any of the eight documented points leaves either the previous state or the new one, never a visible half-checkpoint (gate 2.3).
- `state_only` checkpoints make web-only use honest: the capsule and the timeline exist, and no file restore is promised.
- A `combined` checkpoint requires a storage backend to be healthy *before* the transaction starts; a failing git operation aborts the checkpoint rather than writing a row that cannot be restored.
- Retention and GC have a precise target: checkpoints and unreferenced trees, never live snapshot rows.
- The transaction is short because file capture happens before it; ADR-0026 (snapshot mechanism) is what keeps that pre-work incremental.

## Alternatives considered

- **Two transactions: checkpoint row, then tree ref.** Rejected: a crash between them creates a timeline entry with nothing behind it, which is worse than losing the checkpoint.
- **Write the checkpoint row first, then capture files.** Rejected: the row would be visible before the state it names, and a concurrent reader could page in a head whose tree does not exist.
- **Allow `snapshot_kind='unknown'` as a temporary state.** Rejected: temporary states become permanent, and every consumer would need a branch for it.
- **Delete aborted checkpoints.** Rejected: rewind is the moment a user most needs to understand what happened; deleting the audit trail destroys that.
