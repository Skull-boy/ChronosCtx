# Contributing to ChronosCtx

Thanks for taking the time. This document is short on ceremony and specific about the things that will get a pull request rejected.

## Before you start

- **Bugs and feature ideas:** open an issue using the templates in `.github/ISSUE_TEMPLATE/`.
- **Security issues:** do not open an issue. Follow [SECURITY.md](SECURITY.md).
- **A change to a locked decision** (roadmap §7 D1–D12, or any accepted ADR): open an RFC first. A pull request that contradicts an ADR without one is closed with a link to the ADR, not argued in review.

## Development setup

Requirements: Node ≥ 22.15 (see `.nvmrc`), git ≥ 2.30, and corepack (bundled with Node).

```bash
corepack enable                 # may need elevated permissions on Windows
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm test
```

If `corepack enable` cannot write shims next to the Node binary (a locked-down Windows install, for example), enable them into a local directory instead:

```bash
mkdir .tools/bin
corepack enable --install-directory .tools/bin
export PATH="$PWD/.tools/bin:$PATH"   # PowerShell: $env:PATH = "$PWD\.tools\bin;$env:PATH"
```

`.tools/` is gitignored. Every script also works as `corepack pnpm <task>`, so the shim is a convenience rather than a requirement. Turborepo needs a `pnpm` binary on `PATH`; that is the one step that cannot use `corepack pnpm` as a prefix.

Alternatively, `node scripts/bootstrap.mjs` performs the install and build and reports what it skipped.

## Repository layout

| Path | What lives there |
| --- | --- |
| `packages/shared-types` | Identifiers, paths, errors, budgets. **Zero runtime dependencies** — this is enforced. |
| `packages/core-engine` | Storage, epistemic gate, pager, snapshots, daemon. |
| `packages/cli` | `chronos` command surface. |
| `tests/` | Cross-package integration, crash, security and conformance suites. |
| `bench/` | The Phase 0 measurement harness, retained as evidence and as the seed of the Phase 6 suite. |
| `scripts/` | Bootstrap, phase gates, supply-chain policy, release build. |
| `docs/adr/` | Architecture decisions. Read the index first. |
| `roadmap.md` | The normative architecture. If code and roadmap disagree, that is a bug in one of them — say which. |

## The rules that actually get enforced

1. **Do not commit host details or personal data.** No CPU model, RAM, disk model, OS build number, hostname, username, email address or absolute home path in any tracked file — including benchmark tables, issue templates and screenshots. Benchmarks are published as design cost with the harness and method, not as a machine inventory. This is a hard rule, not a style preference.
2. **Every dependency is an ADR-level decision.** Direct runtime dependencies are capped (currently 8, see ADR-0025) and must be exactly pinned. `shared-types` may not gain a runtime dependency. A new lifecycle script anywhere in the install-time closure fails CI.
3. **No direct writes to epistemic state.** `status` is written by the gate and nowhere else. A test helper that writes `verified` directly will be rejected.
4. **A new behaviour needs a gate.** If it can be wrong, there is an assertion in `scripts/verify-phase.mjs` or a package test that fails when it regresses.
5. **The DDL is normative.** Changing a table means a new forward-only migration, an updated Drizzle mirror, and a green parity test.
6. **Budgets are measured, not asserted.** A change that grows the tool surface, boot payload or page-in response must show the new number.

## Commits and sign-off

- **Conventional commits**: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `perf:`, `build:`, `ci:`.
- **DCO, no CLA.** Every commit must be signed off:

  ```bash
  git commit -s -m "feat(engine): add tree-bound freshness"
  ```

  The sign-off certifies you wrote the change or have the right to contribute it (https://developercertificate.org/).
- Keep commits reviewable. A single change that mixes a schema migration, a refactor and a docs rewrite is hard to verify and will be asked to split.
- User-visible changes need a changeset: `corepack pnpm changeset`.

## Tests and gates

```bash
corepack pnpm lint          # Biome, including formatting
corepack pnpm typecheck     # tsc --noEmit across the workspace
corepack pnpm build
corepack pnpm test
corepack pnpm check:supply-chain
node scripts/verify-phase.mjs --phase 1
```

- Phase 1 will report `pending` gates until they are implemented; that is expected early in the phase and must not be worked around by deleting a gate.
- Property tests that generate histories must use `CHRONOS_DETERMINISTIC=1` and print the seed on failure so a failure is reproducible.
- Benchmark claims must cite the committed harness and the recorded figure in `docs/phase0/REPORT.md`; the JSON artifacts are regenerated locally and are not committed, because they carry host-specific timing and must not become a machine inventory.

## Code style

Biome is the formatter and linter; run `corepack pnpm lint:fix` before pushing.

- TypeScript strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, ESM only, NodeNext resolution.
- No `any`, no non-null assertions. Model uncertain values with a result type.
- Errors crossing a boundary are `ChronosError` with a code from the normative union; do not invent ad-hoc error strings.
- Comments explain *why* a non-obvious choice was made. Do not narrate what the next line does.

## Review

A maintainer reviews for: correctness against the ADR, test coverage of the failure mode, budget impact, and whether the change makes a future invariant harder to hold. Disagreement is resolved by evidence — a measurement, a failing test, or a cited ADR — not by preference.

## Governance

Roles, the RFC process and the release cadence are in [GOVERNANCE.md](GOVERNANCE.md). Participation is covered by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
