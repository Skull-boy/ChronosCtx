# ADR-0008 — Token budgets, envelope accounting, deterministic truncation

- **Status:** Accepted (Phase 1)
- **Related:** roadmap §4.1 estimator rules, §4.5.0, §4.5.2, I6, D9; gates 1.4, 1.5, 1.12, 6.3
- **Supersedes:** nothing
- **Superseded by:** nothing

## Context

"Bounded context" is the product's central promise, so the budget cannot be an informal guideline. Three failure modes have to be excluded:

1. **Hidden overhead.** A response that reports 400 content tokens while its JSON envelope, field names and tool-schema share cost another 250 is not bounded; it is bounded in the part the user can see.
2. **Silent truncation.** Dropping a node without saying so makes the model reason from an incomplete state with no signal.
3. **Non-determinism.** If truncation depends on object iteration order or on a tokenizer version, the same request produces different context on two runs and cache prefixes churn.

## Decision

1. **Budgets are constants in `shared-types`, not per-call ideas:**

   | Surface | Default | Hard |
   | --- | --- | --- |
   | `context_boot` | 150 | 200 |
   | single node | 500 | 800 |
   | `context_page_in` | 800 | 1,200 |
   | capsule | 400 | 500 |
   | negative constraints | 5 items | 10 items |
   | tool surface | 900 | 1,200 |
   | MCP instructions | 300 | 400 |

2. **Every response accounts for three components separately:** `tokens.content`, `tokens.envelope`, `tokens.schema`, and their sum `tokens.total`. The envelope is not free and is never excluded from the budget.
3. **The default estimator is `chars4`** (`ceil(character count / 4)`), tagged in every response. A real tokenizer reports `cl100k_base` when one is registered. Mixing estimators within one response is a bug.
4. **Truncation is deterministic and loud.** `context_page_in` drops whole nodes from the tail of `paths` in request order, then cuts the final node at a sentence boundary. Every truncated response carries `truncated: true` and `omitted_tokens`; silent truncation is a test failure.
5. **Markers are never truncated.** Status and freshness delimiters survive budget pressure; if a node cannot carry its marker, the node is dropped instead.
6. **Overflow of a single oversized node is an error, not a partial success.** If one node still exceeds 800 tokens after truncation, the response is `BUDGET_EXCEEDED` with a suggestion to split the node — the caller must fix the node, not receive a lie about it.
7. **Budgets include the response envelope**, and the schema share is attributed to the call that triggered it, so paging accounting cannot under-report cost.
8. **Boot index uses path + count per group by default.** Summaries are opt-in. Phase 0 measured 183 tokens for counts-only vs 387 with summaries on a 300-node project.

## Consequences

- A budget regression is detectable in CI by comparing serialized response sizes, not by reading code.
- Callers see why a response was cut and can request a narrower page instead of guessing.
- Cache-prefix stability (gate 6.3) depends on this: volatile fields (`updated_at`, `daemon.pid`, latency) must stay out of the model-visible prefix, and truncation order must be stable.
- The estimator is a model, not a guarantee; responses disclose it so a user can reproduce the number with a real tokenizer.
- Oversized nodes are pushed back to the writer (`NODE_OVERSIZED`), which improves the graph rather than hiding the problem at read time.

## Alternatives considered

- **Budget content only.** Rejected: the envelope and schema share are real tokens paid on every request; excluding them makes the claim false.
- **Use a real tokenizer by default.** Rejected for v1: it adds a dependency and a WASM/asset payload to a zero-runtime-dependency client path; `chars4` is conservative enough and is disclosed.
- **Truncate mid-node only.** Rejected: half a decision is worse than no decision, and it hides which node was incomplete. Whole-node drops plus one sentence-boundary cut are explainable.
- **Return partial success on any overflow.** Rejected: it makes `BUDGET_EXCEEDED` impossible to observe and teaches callers to ignore it.
