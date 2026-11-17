# ADR-0006 — Seven MCP tools, a flagged eighth, and a lean profile

- **Status:** Accepted (Phase 1); MCP surface ships in Phase 2
- **Related:** roadmap §4.5, §5 Phase 2, D9, I6; gates 1.12, 3.10
- **Supersedes:** nothing
- **Superseded by:** nothing

## Context

Every tool definition, description and JSON Schema is paid on **every** request, before the model does any work. Phase 0 measured the real surface:

| Contract | Tokens |
| --- | --- |
| Full schemas + descriptions | 1,795 |
| Reduced contract (required properties + `project_id`/`branch`) | 663 |
| Full schemas with **every description deleted** | 1,444 |
| Reduced contract, descriptions removed | not a viable product |

The 1,444-token floor is the important number: descriptions are not the problem, the schemas are. A large tool surface silently consumes the budget the product claims to protect.

## Decision

1. **Seven tools ship in Phase 2:** `context_boot`, `context_page_in`, `context_commit`, `context_checkpoint`, `context_rewind`, `context_fork`, `context_flag_dead_end`.
2. **`context_merge` is the eighth tool and is feature-flagged** (`CHRONOS_ENABLE_MERGE_TOOL=1`, Phase 3). In Phase 2 it exists only as a CLI command. Enabling it re-measures the surface and can fail the build.
3. **The published contract is the reduced one:** required properties plus `project_id` and `branch`. The full schema is available as a resource (`chronos://schema/full`), not in the tool list. Measured reduced cost: **663 tokens**.
4. **Budget:** ≤ 1,200 tokens hard for all tool definitions plus server instructions, ≤ 900 target. The measurement is a gate, not an estimate, and it counts the serialized form the client actually receives.
5. **Lean profile = four tools:** `context_boot`, `context_page_in`, `context_commit`, `context_checkpoint` (≤ 600 tokens). It is the minimum coherent loop — read the index, page in detail, write a node, save a checkpoint — and is intended for hosts with a small context window. It is selected explicitly, never auto-detected by guessing a model's window.
6. **Tool names are stable identifiers.** Renaming a tool is a protocol change (Phase 3 conformance suite), not a refactor.
7. **No tool returns unbounded content.** Every response is budgeted and accounts for content + envelope + schema separately (ADR-0008).

## Consequences

- The server instructions are part of the budget; a helpful paragraph costs the same as a tool.
- The reduced contract means a model cannot set optional fields on the first call; defaults must be documented and sane, and a `warnings[]` entry explains any default that changed an outcome.
- The lean profile is a second schema set to test and keep in sync. The surface gate runs both profiles, and a tool added to `full` without a decision about `lean` fails review by checklist.
- Merge being flagged keeps the common surface smaller while preserving the capability; the CLI path is tested independently.
- Adding an eighth permanent tool later requires re-opening this ADR with a measurement, not a preference.

## Alternatives considered

- **One mega-tool with an `action` discriminator.** Rejected: the schema is larger than the sum of the seven for a model to reason about, and every error becomes a union error. Phase 0's numbers make the opposite bet rational: small, separate schemas.
- **Ship all eight including merge.** Rejected: merge is rare, conflict-shaped and easy to misuse; paying its schema on every request is the wrong trade.
- **Full schemas with descriptions trimmed.** Rejected by measurement: removing every description still costs 1,444 tokens.
- **Auto-select the lean profile from context length.** Rejected: model context lengths are advertised inconsistently and change; a wrong auto-choice silently removes capability. Explicit profile selection is honest.
