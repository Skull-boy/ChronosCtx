# ADR-0005 — Epistemic demotion on content mutation; evidence-only promotion

- **Status:** Accepted (Phase 1)
- **Related:** roadmap §2.6, §4.4, I2, D2; gates 1.2, 1.3, 1.7, 1.8
- **Supersedes:** nothing
- **Superseded by:** nothing

## Context

A context store that renders every stored sentence as equally true is worse than a transcript, because it launders a guess into a fact. The product claim is that the daemon labels every payload, so an unverified statement cannot render as plain truth. That claim only holds if `status` has exactly one writer and if promotion is tied to evidence that can go stale.

Phase 0 also showed why a stored boolean is insufficient: the same reasoning node can be correct when written and wrong after the next code change. Trust has to be a function of (evidence, current tree), not a flag set once.

## Decision

1. **Three states only:** `unverified`, `verified`, `deprecated`. There is no `partially_verified`, `trusted`, or numeric confidence in the head row; proposals (Phase 4) may carry confidence, but a committed node does not.
2. **`gate.ts` is the only writer of `status`.** Repositories ask the gate for a transition; no route, migrator or test helper writes `status` directly. A CI grep for direct writes is a defence in depth, not the primary control.
3. **Promotion requires evidence.** `context_commit(status="verified")` must supply either an inline verification block (command, exit code 0, covered paths) or a `verification_event_id`. Otherwise it fails with `EVIDENCE_REQUIRED`; it never silently downgrades to `unverified`, because a silent downgrade hides the caller's mistake.
4. **Web surfaces cannot self-promote.** `source_surface ∈ {gemini-web, chatgpt-web, claude-web, qwen-web}` is forced to `unverified` regardless of the requested status, and forged evidence is rejected on the authenticated surface, never on the payload's claim.
5. **Content mutation demotes; nothing else is metadata.** `content_hash` covers title, summary and content (§4.2), so an edit to any of the three is a content change and produces `unverified`. The only case that preserves `verified` is a re-commit of byte-identical text, which still bumps the version and carries the previous evidence forward. This is the fail-closed reading of §2.6 rule 4: a summary is model-visible, so treating it as non-semantic metadata would let a claim change without re-verification.
6. **Verification is immutable and linked.** Every promotion inserts a `verification_events` row and stores its `verification_event_id` and `verified_tree_hash` on the version. Rewind never deletes evidence; it only changes which head points where.
7. **Deprecated is excluded from boot but retrievable by path**, with a `DEPRECATED` warning. Deleting a decision is not the same as retiring it.
8. **Labels are daemon-generated and non-suppressible.** `<<<UNVERIFIED …>>>` and `<<<STALE — verified against <tree>, current tree differs>>>` are emitted by the renderer; no tool argument can turn them off.
9. **Agent-authored blocking constraints are not trusted.** A negative constraint defaults to `caution`; promotion to `blocking` requires a human or CI promotion path with evidence.

## Consistency note: what "metadata-only" means here

§1.3 and §2.6 describe preserving `verified` across "title/summary-only" edits, while §4.2 defines `content_hash` over title, summary **and** content. Those cannot both hold: any label edit changes the hash. Phase 1 resolves the ambiguity in favour of the safer rule — any text change demotes — and keeps the roadmap's hash definition unchanged. The version still increments, so the label change is visible in history; it simply does not inherit trust. If a future decision wants label-only preservation, it must introduce a separate body hash and amend this ADR, rather than reinterpreting `content_hash`.

## Consequences

- The invariant test is meaningful: 10k random commit sequences must produce zero unevidenced `verified` heads and zero false-`fresh` nodes (gate 1.2/1.8).
- Callers that want `verified` must run a command and report what it covered; the API cannot be used as a "trust me" switch.
- A metadata edit is a real version bump, so history shows the label change without pretending the claim was re-proven.
- Rewind cannot resurrect trust: restoring a `verified` head restores the version row, and freshness is recomputed against the current tree, so a stale proof stays visibly stale.
- The renderer carries the epistemic burden; every page, capsule and boot index must be tested for marker presence.

## Alternatives considered

- **Store `verified: boolean`.** Rejected: it goes stale silently, which is precisely the failure the product exists to prevent.
- **Promote on user approval alone, with no tree binding.** Rejected: "the user said it was fine" does not say *what* was fine; approval is one evidence kind, still bound to a tree and covered paths.
- **Let agents self-declare evidence.** Rejected: an agent can emit a `verification` block for a command it did not run. The daemon accepts inline evidence only for trusted local surfaces and validates exit code and coverage; web surfaces are excluded entirely.
- **Silently downgrade a requested `verified` to `unverified` when evidence is missing.** Rejected: it turns a caller bug into a quiet epistemic change, and the caller never learns that nothing was verified.
- **Four states with `stale` stored.** Rejected: freshness is computed against a moving tree; storing it guarantees the stored value will be wrong.
