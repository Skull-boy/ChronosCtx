# Maintainers

Maintainers are accountable for a named area. The authoritative list of people with merge rights is the repository's GitHub access and `.github/CODEOWNERS`; this file records the areas so a change can find the right reviewer.

| Area | Scope | Owner |
| --- | --- | --- |
| Core engine | `packages/core-engine`, schema, migrations, epistemic gate, snapshots | *open — see CODEOWNERS* |
| Client surface | `packages/shared-types`, `packages/cli`, MCP proxy | *open — see CODEOWNERS* |
| Bridges and extension | `packages/bridges`, `extension/` (Phase 3+) | *open — see CODEOWNERS* |
| Release and supply chain | `.github/`, `scripts/`, `.npmrc`, provenance, SBOM | *open — see CODEOWNERS* |
| Security | `SECURITY.md`, threat model, disclosure | *open — see CODEOWNERS* |
| Docs and claims | `roadmap.md`, `docs/`, benchmark claims | *open — see CODEOWNERS* |

## What a maintainer agrees to

- Review within a reasonable window, or say when they cannot.
- Merge only with CI green and the phase gate satisfied; no "merge now, gate later".
- Hold the invariants (roadmap I1–I12) even when a change is convenient.
- Respond to a security report within the 72-hour acknowledgement target in `SECURITY.md`.
- Never commit host details, personal data, credentials or benchmark results without their artifacts.

## Becoming a maintainer

Sustained, high-quality contribution in an area; nomination by an existing maintainer; consensus of maintainers. The nomination states the area and the evidence. Removal follows the same path, for inactivity over six months or for a conduct decision under `CODE_OF_CONDUCT.md`.

## Emeritus

Former maintainers are listed here when they step down, with their dates of service, once the project has a public history to record. No names are added before they consent.
