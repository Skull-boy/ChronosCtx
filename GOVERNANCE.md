# Governance

ChronosCtx is an Apache-2.0 open-source project. This document describes who decides what, how a decision is changed, and what a release means. It is deliberately small: process that does not protect correctness is overhead.

## Principles

1. **Evidence over preference.** A design argument is settled by a measurement, a failing test, or a cited ADR — not by seniority or volume.
2. **Invariants are not negotiable by convenience.** The roadmap's I1–I12 and the accepted ADRs are the contract. Changing one is a deliberate, documented act.
3. **Honesty in claims.** A number is published with its method and its artifact, or it is not published. A limitation is stated, not omitted. Nothing is called a "standard" before the conformance suite ships.
4. **Small surface, named owners.** Every area has a maintainer who is accountable for it, even when the set is one person.

## Roles

| Role | Responsibilities | How you get it |
| --- | --- | --- |
| **Contributor** | Opens issues and pull requests, signs off commits (DCO) | Anyone |
| **Reviewer** | Reviews a defined area, may approve but not merge | Sustained, high-quality contributions; nominated by a maintainer |
| **Maintainer** | Merges, cuts releases, holds the ADR/RFC decision, handles security reports | Nominated by an existing maintainer, confirmed by consensus of maintainers |
| **Release manager** | Runs a release: versioning, provenance, signed artifacts, advisory check | A maintainer, rotating per release |

The current maintainer set is the repository's GitHub organisation members with write access, mirrored in `.github/CODEOWNERS`. Adding or removing a maintainer is a pull request to both, with the reason stated.

## Decision process

### Ordinary changes

A pull request plus one maintainer approval, with CI green. Review covers correctness, tests, budget impact and ADR consistency.

### RFC — for anything that changes a contract

Required for:

- a change to a locked decision (roadmap §7 D1–D12);
- a new or amended ADR, including a new runtime dependency;
- a change to the SQL schema beyond a forward migration that preserves semantics;
- a change to a protocol identifier (`paging-v1`, `capsule-v1`, `mcp-surface-v1`, `db-schema-v1`);
- a change to the epistemic model, budgets, or the security boundary.

Process:

1. Open a pull request adding `docs/rfcs/NNNN-title.md` (status: Proposed) that states the problem, the proposal, the alternatives, the evidence, and the migration/compatibility impact.
2. Discussion runs in that pull request for at least **7 days**. For a change that breaks a published protocol, 14 days.
3. A maintainer records the outcome as **Accepted**, **Rejected** or **Withdrawn**, and an accepted RFC that changes a decision produces an ADR amendment in the same series of commits.
4. Silence is not consent. An RFC with unresolved objections does not become accepted because time passed.

### ADRs

ADRs record *why*. An accepted ADR is binding. It is superseded by a new ADR that names the evidence which changed, never by editing the old one into agreement. The index is `docs/adr/README.md`; the required set is Appendix B of `roadmap.md`.

### Disagreement and appeals

If a contributor and a maintainer disagree on a technical decision, the RFC text should carry both positions and the evidence for each. If the disagreement is about conduct, see `CODE_OF_CONDUCT.md`. Maintainers decide by consensus; if consensus fails, the maintainer owning the area decides and records the reasoning in the RFC. That is a tie-break, not a veto over the invariants.

## Releases

- **Cadence:** patch releases as needed, minor releases when a coherent set of changes is ready. No date-driven release that ships an unmeasured claim.
- **Versioning:** SemVer for the CLI and packages; the protocol identifiers carry their own version and are not implied by the package version.
- **Pre-1.0:** breaking changes are allowed in a minor release and must be in the changeset and the changelog. After 1.0, a breaking change requires a major version and a migration note.
- **A release is blocked by:** a failing phase gate, a failing supply-chain policy check, a missing provenance attestation, an unreviewed security advisory in the runtime closure, or a claim in the changelog without an artifact behind it.
- **Release provenance:** trusted publishing (OIDC, no long-lived npm token), signed artifacts, an SBOM, and a changelog entry that states what was measured.
- **Revocation:** a bad release is deprecated/unpublished the same day with an advisory in `SECURITY.md`'s process, not quietly replaced.

## Security

Security reports follow `SECURITY.md`. A maintainer is on point for each report; the acknowledgement target is 72 hours and the fix targets are in that document. A security fix may bypass the normal RFC window, but it does not bypass review by a second maintainer when one is available.

## Changes to this document

A pull request with maintainer consensus, and a 7-day comment window when it changes who can merge or how a decision is appealed.

## Project assets

- **License:** Apache-2.0, including its trademark clause. The name and logo are not granted for use that implies endorsement.
- **Code of conduct:** Contributor Covenant 2.1, enforced as described in `CODE_OF_CONDUCT.md`.
- **Contributions:** DCO sign-off, no CLA.
- **Trademark:** the project name must be cleared before any public release; until then, no compatibility badge or "official" claim is made by third parties or by this project.
