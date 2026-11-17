# ADR-0014 — Tree-bound verification and computed freshness

- **Status:** Accepted (Phase 1)
- **Related:** roadmap §2.6, §4.2 `verification_events`, §7 D2, I2; gates 1.2, 1.8, 2.8
- **Supersedes:** nothing
- **Superseded by:** nothing

## Context

"Verified" is only meaningful relative to something. A stored `verified: true` on a node says a command passed at some point; it does not say the command exercised this node, nor that the code it exercised is still the code on disk. Both omissions turn trust into a rumour.

The naive fix — invalidate every verified node whenever any file changes — is also wrong: an unrelated edit to a README would mark the whole project stale, and users would learn to ignore the marker.

## Decision

1. **Every `verification_events` row stores `tree_hash`, `snapshot_hash` and `covered_paths[]`.** `covered_paths` is the set of files/directories the command actually exercised; it is required, not best-effort.
2. **Freshness is computed at read time, never stored as truth:**
   - `fresh` ⇔ `diff(current_tree, vev.tree_hash) ∩ covered_paths = ∅`
   - `stale` ⇔ that diff touches at least one covered path
   - `unknown` ⇔ `vev.tree_hash IS NULL` (no workspace) or `covered_paths` is empty (nothing was proven)
3. **Whole-tree equality is sufficient but not required.** An unrelated edit must not invalidate every verified node in the project.
4. **The computed value is cached per (node, response) for one request only.** A cached freshness value must never outlive the tree it described.
5. **Markers are rendered in every page-in and capsule**, with a reason (`"tree changed in 3 covered paths"` / `"no workspace attached"`). They cannot be suppressed by a tool argument.
6. **Content mutation replaces evidence, it does not reinterpret it.** A new version with a different `content_hash` cannot inherit `verified_tree_hash`; only a new `verification_events` row can promote it.
7. **Evidence is immutable and redacted.** `log_hash` is sha256 of the redacted log and `log_excerpt` is capped at 2 KB; secrets never enter the ledger.

## Consequences

- The invariant is testable: 5k generated histories must produce zero false-`fresh` nodes and 100 % flagging of nodes whose covered paths changed.
- `covered_paths` becomes a product concern: a test command that reports `["."]` covers everything and will go stale constantly, while a precise command stays fresh. The docs must say so.
- Diffing the current tree costs a manifest comparison, not a full scan, once the shadow store exists (Phase 2). In Phase 1 the computation is exercised against supplied tree hashes so the logic is gated before the tree exists.
- A web-only project is always `unknown`, which is honest rather than flattering.

## Alternatives considered

- **Store a `verified` boolean.** Rejected: it goes stale silently, and there is no way to explain why a marker changed.
- **Timestamp expiry.** Rejected: trust does not decay with time; it decays with change. A node verified against an unchanged tree stays valid indefinitely.
- **Whole-tree equality.** Rejected: one unrelated edit invalidates everything, and users stop trusting the marker — the exact opposite of the goal.
- **Compute freshness on write and store it.** Rejected: the value is wrong the moment the next file is saved; storing it guarantees a lie.
