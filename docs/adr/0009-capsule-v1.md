# ADR-0009 — Capsule v1: fixed order, mandatory freshness markers, render hash

- **Status:** Accepted (Phase 1)
- **Related:** roadmap §4.6, §2.5, I7, D2; gates 1.6, 1.8, 1.9
- **Supersedes:** nothing
- **Superseded by:** nothing

## Context

A capsule exists for one moment: the user clears a polluted conversation, or a web tab is re-opened, and the state has to be reconstructed without dragging the transcript along. Three properties matter:

- **It must be paste-ready**, so it is text, not a JSON blob the model has to parse.
- **It must be citable**, so a capsule attached to a bug report or a decision can be checked later.
- **It must not launder trust**, so a stale or unverified node cannot appear as plain truth in the text.

A capsule that includes "generated at 2026-11-17T09:52:11Z" is not citable: bytes differ on every render and a hash comparison proves nothing.

## Decision

1. **The text format is `CHRONOS CAPSULE v1` with a fixed section order:** header (project, branch, head, tree, snapshot), objective, `VERIFIED (trust)`, `HYPOTHESES (validate before use)`, `DO NOT RETRY`, `SIDE EFFECTS IN RANGE`, `RESUME PROTOCOL`.
2. **No volatile fields in model-visible text.** No timestamps, durations, hostnames, daemon pids or absolute paths. Only stable identifiers, paths, versions and content. `render_hash` is therefore reproducible across machines.
3. **Freshness and status markers are mandatory in the text**, not only in the JSON: `[fresh]`, `[stale: tree moved in N covered paths]`, `[unknown: no workspace]`, and `<<<UNVERIFIED …>>>` delimiters where a node is not trusted. A capsule that renders a stale node as truth is a defect.
4. **JSON is returned alongside the text**: `snapshot_hash`, `content_root`, `head_checkpoint_id`, `tree_hash`, `nodes[]`, `constraints[]`, `side_effects[]`, `budgets`, `generator_version`, `render_hash`.
5. **Trimming order is fixed:** drop `unverified` lines first, then constraint detail, then hypotheses. Verified content and the resume protocol are the last things removed, and any removal is reported in JSON.
6. **Capsules verify:** `chronos capsule verify <file>` recomputes `render_hash` over the model-visible text and refuses a doctored capsule. The hash excludes the JSON wrapper.
7. **Capsules are produced from a snapshot**, never from "whatever the heads are now": the header cites the checkpoint and tree, and the node list is the snapshot's, so a concurrent write cannot produce a capsule that mixes two states.
8. **Web capsules are forced `unverified`** for any node whose source is a web surface, even if the node was previously verified elsewhere, unless the evidence is still fresh against the cited tree.

## Consequences

- Two renders of the same snapshot produce identical bytes, which is what makes the artifact citable and the snapshot tests meaningful.
- The renderer is a product surface: section labels, ordering and marker wording are contract, changed only with a protocol version.
- Trimming can remove the very constraint a user needed; that is why the removal is reported in JSON and why the `DO NOT RETRY` section is trimmed after hypotheses, not before.
- A capsule moved between devices compares by `content_root`, not `snapshot_hash`, avoiding a false conflict on arrival (ADR-0011).
- `generator_version` changes when rendering changes, so a verification failure can be attributed to a renderer change rather than a tampered file.

## Alternatives considered

- **JSON-only capsule.** Rejected: a model pasting JSON into a new chat is work the product should do; the text is the artifact.
- **Include a timestamp for provenance.** Rejected: it breaks byte-identical rendering and is not needed — the checkpoint id already identifies the moment.
- **Render from live heads.** Rejected: racing a commit would produce a capsule that never existed as a state.
- **Hash the whole response including JSON.** Rejected: the JSON contains fields that may legitimately be re-serialized; the hash must cover the text a human or model actually reads.
