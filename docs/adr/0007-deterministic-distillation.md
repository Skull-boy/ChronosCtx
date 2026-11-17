# ADR-0007 — Deterministic distillation is the default; the LLM distiller is opt-in

- **Status:** Accepted (Phase 1); capture/distillation ship in Phase 4
- **Related:** roadmap §2.8, §4.7, I7, §4.2 `captures`/`proposals`; gate 4.x
- **Supersedes:** nothing
- **Superseded by:** nothing

## Context

Web surfaces and some harnesses produce raw transcripts, not structured state. Turning a transcript into nodes requires extraction. An LLM extractor is the obvious tool and the wrong default:

- it is non-deterministic, so the same transcript can produce different state on two runs;
- it calls a model from inside a product whose pitch is local-first, and that call needs a key, a budget and a privacy story;
- it is unfalsifiable in CI unless every call is recorded;
- a model that summarizes a transcript can invent a decision that was never made.

At the same time, a regex-only extractor will miss genuinely useful structure in prose-heavy captures.

## Decision

1. **The default distiller is deterministic:** `deterministic@1`. Same capture + same extractor version ⇒ byte-identical proposals, verified by golden fixtures with `CHRONOS_DETERMINISTIC=1`.
2. **Pipeline order is fixed:** normalize → redact secrets → segment by turn/tool-call → deterministic extractors (decision statements, code blocks + target paths, test/build evidence, corrections) → supersession detection → dedupe (MinHash + structural diff, no embeddings) → `proposals(pending)`.
3. **Distillation never writes a node.** It writes proposals. Acceptance is a separate, explicit action by a human or a trusted agent, and the resulting node is `unverified` until evidence arrives through the gate (ADR-0005).
4. **The LLM distiller is opt-in and behind the same `Distiller` interface.** It is off by default, requires explicit configuration, and is tested against recorded cassettes so CI never calls a provider.
5. **Supersession produces both artifacts:** when turn N corrects turn M, a single node is proposed **and** a negative constraint is recorded. The correction is knowledge; the dead end is knowledge too.
6. **Dedupe does not need embeddings.** MinHash plus a structural diff is deterministic, dependency-free and explainable; embeddings may rank later, but they are not allowed to decide identity.
7. **Raw captures are retained and redacted**, with `redaction_json` recording what was removed. A proposal can always be traced back to the capture and turn that produced it.

## Consequences

- The same transcript re-imported produces the same proposals, which makes fixtures and review diffs meaningful.
- Deterministic extraction will under-extract on prose; that is accepted and is why the LLM distiller exists as an option rather than being removed.
- Proposal acceptance is a product surface (`chronos proposals list|accept|reject`), not an implicit side effect of import.
- Redaction must run before any model call, or the opt-in path becomes a secret-leak path. It runs before segmentation regardless of distiller.
- Cassettes are test fixtures with a fixed redaction pass; a cassette must never contain a real credential.

## Alternatives considered

- **LLM-first distillation.** Rejected as default: non-deterministic, non-local, expensive per capture, and easy to make up decisions. Kept as opt-in.
- **Regex-only, no LLM path.** Rejected: prose-heavy web captures would be unusable, and the interface cost of a second distiller is small once proposals are the boundary.
- **Auto-accept high-confidence proposals.** Rejected: confidence is assigned by the same component that proposed the node; auto-accept launders the extractor's guess into state.
- **Embedding-based dedupe as the identity rule.** Rejected: approximate by construction, non-reproducible across model versions, and unexplainable when it merges two decisions that differ.
