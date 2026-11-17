# ADR-0016 — One authoritative head; no denormalized project head

- **Status:** Accepted (Phase 1)
- **Related:** roadmap §4.2, §7 D4, I10; gates 1.1, 2.13, 4.x
- **Supersedes:** nothing
- **Superseded by:** nothing

## Context

Every read path wants "the current checkpoint". The convenient implementation is a `projects.head_checkpoint_id` column updated alongside `branches.head_checkpoint_id`. It is convenient exactly once: after that, two rows claim to be the head, and any crash, merge or rewind can leave them disagreeing. Whichever one a query happens to read becomes the truth.

## Decision

1. **Branch head exists only in `branches.head_checkpoint_id`.** There is deliberately no `projects.head_checkpoint_id` column in the DDL.
2. **A "project head" is derived at read time** as the head of the project's active branch, resolved through `projects.default_branch`/`active_branch` as a *UI preference only*. `active_branch` is not a source of truth for history.
3. **Checkpoints carry `branch_name`** so history remains readable even if a branch row is later archived, but the pointer that defines "now" is the branch row and nothing else.
4. **Fork, merge and rewind update the branch row in the same transaction that writes the checkpoint or the rewound state.** There is no asynchronous head repair.
5. **Uniqueness is enforced**: `branches` has `UNIQUE (project_id, name)`, so one project cannot have two rows named `main` with different heads.
6. **A schema review must reject a second writable copy of head.** This is a standing invariant (I10), not a one-off cleanup.

## Consequences

- `chronos status` and boot index do one lookup, not a consistency check between two columns.
- A project with multiple active branches has no single "head" by design; the UI shows per-branch heads and derives the active one explicitly.
- Sync and merge must update branch rows atomically with checkpoint rows; the atomicity requirement is stated once, in ADR-0018.
- Schema changes that add a convenience denormalization must name the reconciler that keeps it correct, or be refused.

## Alternatives considered

- **Store `projects.head_checkpoint_id` and treat it as authoritative.** Rejected: it is a second writer for one fact, and every crash becomes an ambiguity.
- **Store head only on the checkpoint DAG as "latest by created_at".** Rejected: a rewind or a fork makes wall-clock ordering wrong, and two checkpoints can share a millisecond.
- **Derive head from a view over `created_at`.** Rejected: it cannot represent a rewind that deliberately moves backwards.
- **Keep both and reconcile on read.** Rejected: reconciliation logic is a bug farm and hides the disagreement instead of preventing it.
