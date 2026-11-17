# ADR-0015 — Typed `node_edges` layer and orphan reporting

- **Status:** Accepted (Phase 1)
- **Related:** roadmap §3.2, §4.2 `node_edges`, §7 D3, C3; gates 1.6, 2.14
- **Supersedes:** nothing
- **Superseded by:** nothing

## Context

A tree of paths is not a graph. If `backend/auth/jwt-spec` depends on `db/schema`, a path prefix does not express that, and a model paging in one node has no principled way to know what else is relevant. Embedding similarity can rank candidates, but it cannot say *why* two nodes are related and it changes when the model changes.

At the same time, a graph that silently keeps edges after a rename or merge is worse than no graph: it points at paths that no longer exist and produces confident nonsense.

## Decision

1. **Edges are explicit rows** in `node_edges(project_id, from_path, to_path, rel, weight, origin)`, with `UNIQUE (project_id, from_path, to_path, rel)`.
2. **The relation vocabulary is fixed:** `depends_on`, `implements`, `supersedes`, `contradicts`, `documents`, `tests`, `blocks`, `related_to`. An unknown relation is rejected, not stored and ignored.
3. **Edges are version-agnostic by endpoint.** An edge connects paths; the version each path currently points at is resolved at read time. This keeps rewrites small and makes an edge survive a version bump.
4. **Self-edges are rejected**, and both endpoints must pass the node-path grammar. `origin` distinguishes `manual`, `inferred`, `import` and `merge`.
5. **One-hop expansion only in `page_in`**: summaries of neighbours, max 3 relations per call. Enough to choose the next page, never enough to blow the budget.
6. **Rename, merge and revert recompute edges.** An edge whose endpoint no longer exists is reported as `EDGE_ORPHANED` with the offending path — never silently kept and never silently deleted.
7. **Embedding similarity may rank, never assert.** If a future feature suggests an edge from similarity, it is created as a proposal with `origin='inferred'`, not as truth.

## Consequences

- `chronos graph --from <path> --rel depends_on --depth 2` is a real query, not a heuristic.
- A merge must walk edges for both endpoints and report orphans in the merge result; that is extra work that the atomic checkpoint transaction (ADR-0018) has to accommodate.
- Deleting a path is now a graph operation with an observable outcome, which surfaces dead references instead of hiding them.
- The fixed vocabulary keeps payloads small and lets the model reason about relation names it has seen before.

## Alternatives considered

- **Infer edges from path prefixes.** Rejected: `backend/auth` and `backend/db` share a prefix and have nothing to do with each other; the resulting graph is noise.
- **Free-text relation labels.** Rejected: not queryable, not renderable compactly, and every model invents a different word for "depends on".
- **Version-pinned edges (`from_version_id`/`to_version_id`).** Rejected: it multiplies rows on every commit and makes "what does this node relate to now?" a history query instead of a lookup.
- **Delete orphaned edges silently.** Rejected: the user loses the information that a link was broken and cannot fix it.
