# ChronosCtx

**A universal stateful context OS and time-travel harness for LLM coding agents.**

ChronosCtx gives a coding agent a durable, versioned memory of a project — what was decided, what was tried and failed, what the code looked like when a decision was made — and the ability to restore both the files *and* the reasoning state to an earlier point.

> **Status: Phase 0 complete; Phase 1 (core state graph engine) in progress.**
>
> Phase 0 measured the architecture instead of assuming it: `docs/phase0/REPORT.md` holds the verdict — **GO for Phase 1, conditional on amendments A1–A8**, adopted by `roadmap.md` v1.3.
>
> What exists today: the workspace, the normative schema and migrations, the Drizzle mirror with a parity gate, typed identifiers and node paths, the error contract, budget constants, the project/branch/node/snapshot/checkpoint repositories, a D1-compliant `context_commit` core with the epistemic gate, state-only checkpoints with dedupe, the `chronos` CLI (`migrate`, `doctor`, `project`, `stats`), the supply-chain policy check, CI, and the phase-gate runner. There is **no daemon, MCP server, pager or extension yet**; gates that depend on them report `pending` and fail the runner on purpose. The runner is the source of truth for phase status:
>
> ```bash
> node scripts/verify-phase.mjs --phase 1
> ```

---

## What Phase 0 established

Nine kill criteria were measured on two hosts, not estimated:

| Question | Verdict |
| --- | --- |
| Can checkpointing be automatic and cheap? | **Not with `git add -A`.** Against a 60 ms budget the full scan costs 110 ms p95 on Linux and 1,160 ms on Windows. A watcher-driven incremental manifest costs 6.7 / 27.8 ms. |
| Does identical content produce identical hashes across OSes? | **Yes for content** (7/9 cases, including sha256 repos and CRLF worktrees with shadow attributes); symlinks and case-only collisions are refused by design. |
| Is rewind safe and fast? | **Safe.** Both type-conflict directions and three crash points resume to a verified tree. Fast only with changed-path checkout (164 ms Linux vs 493 ms). |
| Do the token budgets hold? | **No.** All 7 tool schemas cost 1,444 tokens with every description deleted; the reduced contract is 663. A 300-node boot index is 183 tokens with counts-only groups. |
| Does paging actually save tokens? | **66.0 % raw, but −44.4 % once prompt caching is priced in.** The claim is bounded context growth, not cheaper tokens. |
| Does the supply-chain model survive? | **Yes.** The install resolves 1 package, 0 transitive, 0 lifecycle scripts — proven with a hostile-package control. |
| Does a web adapter work? | **16/16 behaviours on fixtures.** Live-site validation is Phase 5 evidence and is not claimed. |

The uncomfortable numbers are in the report, not softened: [`docs/phase0/REPORT.md`](docs/phase0/REPORT.md).

---

## Quickstart (development)

Requirements: **Node ≥ 22.15** (see `.nvmrc`), **git ≥ 2.30**, and corepack (bundled with Node).

```bash
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm test
```

If corepack cannot write shims next to the Node binary — common on a managed Windows install — install them locally:

```bash
mkdir .tools/bin
corepack enable --install-directory .tools/bin
# bash:
export PATH="$PWD/.tools/bin:$PATH"
# PowerShell:
$env:PATH = "$PWD\.tools\bin;$env:PATH"
```

`.tools/` is gitignored. Turborepo needs `pnpm` on `PATH`; every other task also runs as `corepack pnpm <task>`.

`node scripts/bootstrap.mjs` does the install and build and tells you which shim path it used.

### Useful commands

```bash
corepack pnpm lint                 # Biome (format + lint)
corepack pnpm typecheck            # strict tsc, all packages
corepack pnpm test                 # vitest, all packages
corepack pnpm check:supply-chain   # six-rule supply-chain policy
node scripts/verify-phase.mjs --phase 1          # gate runner
node scripts/verify-phase.mjs --list             # every gate and its status
```

### CLI

The CLI talks to the engine in-process for now; the daemon arrives in Phase 1.9 and becomes the single writer.

```bash
node packages/cli/dist/index.js doctor              # node, schema, WAL, FK, busy_timeout
node packages/cli/dist/index.js migrate --check     # exit 1 if anything is pending
node packages/cli/dist/index.js project create toy-api -n "Toy API"
node packages/cli/dist/index.js project fork toy-api redis-rate-limit
node packages/cli/dist/index.js project list
node packages/cli/dist/index.js stats --dedupe      # checkpoints vs snapshot rows
```

`CHRONOS_HOME` selects the state directory (default `~/.chronos-ctx`); it must not be on a synced or network drive.

---

## Layout

```text
roadmap.md                      # v1.3 — the normative architecture (schema, tools, gates)
packages/
  shared-types/                 # IDs, node paths, errors, budgets. Zero runtime dependencies.
  core-engine/                  # storage, migrations, epistemic gate, pager, snapshots, daemon
    migrations/0001_init.sql    # the normative DDL, transcribed from roadmap §4.2
    src/db/schema.ts            # Drizzle mirror, parity-tested against the DDL
  cli/                          # `chronos migrate|doctor|project|stats`
docs/
  adr/                          # architecture decisions (0001–0018, 0025–0026 written)
  phase0/REPORT.md              # the Phase 0 verdict, gate by gate
  phase0/METHOD.md              # how every number was produced, and its confounds
  supply-chain/baseline.json    # build-time lifecycle-script ratchet
scripts/
  bootstrap.mjs                 # one-command install + build
  verify-phase.mjs              # phase gate runner; `pending` fails the run
  check-supply-chain.mjs        # six-rule policy check
bench/                          # the Phase 0 measurement harness (preserved evidence)
.github/workflows/              # CI matrix + supply-chain scanning
```

---

## Design commitments

These are not aspirations; they are enforced in code or in CI, and each has an ADR:

- **One writer.** A local daemon owns the database; MCP surfaces are stdio proxies. Contention returns `PROJECT_BUSY`, never a silent lock wait. ([0001](docs/adr/0001-daemon-first-single-writer.md))
- **Trust is evidence-bound.** A node is `unverified`, `verified` or `deprecated`; only the epistemic gate writes that field, `verified` requires tree-bound evidence, and freshness is computed at read time. ([0005](docs/adr/0005-epistemic-gate.md), [0014](docs/adr/0014-tree-bound-freshness.md))
- **Identical state is stored once.** Snapshots carry two identities: a local `snapshot_hash` and a portable `content_root`. ([0017](docs/adr/0017-content-addressed-snapshots.md))
- **Budgets are measured, including the envelope.** Silent truncation is a test failure. ([0008](docs/adr/0008-budgets-truncation.md))
- **Capsules are citable.** Fixed order, no timestamps in model-visible text, a reproducible `render_hash`. ([0009](docs/adr/0009-capsule-v1.md))
- **Install executes nothing.** 1 package, 0 transitive, 0 lifecycle scripts; the build tree is ratcheted. ([0025](docs/adr/0025-supply-chain-model.md))

## Reproducing the Phase 0 numbers

The harness is retained, and its dependencies are dev-only:

```bash
corepack pnpm bench:tokens        # fastest gate; no fixtures needed
corepack pnpm bench:manifest
corepack pnpm bench:rewind
corepack pnpm bench:checkpoint
corepack pnpm bench:determinism   # cross-OS comparison needs both hosts
```

Fixtures are generated deterministically outside the repository. `docs/phase0/METHOD.md` documents each run, the hosts, and the confounds; artifacts land in `bench/results/`, which is gitignored because timing is machine-specific.

---

## Two things worth knowing before reading benchmark numbers

1. **Windows figures are host-bound.** Real-time scanning and per-process cost dominate them. The harness reports a spawn floor beside every series so design cost and host cost stay separable. Host details are deliberately not published — the method and the artifact are, the machine inventory is not.
2. **The token model is a model.** Phase 0 had no working agent, so the 8-turn scenario is computed from named constants and reported both raw and cache-adjusted, because prompt caching reverses the sign.

---

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) — it lists the rules that actually get enforced (DCO sign-off, no host details in tracked files, no direct writes to epistemic state, a gate for every new behaviour). Governance and the RFC process are in [GOVERNANCE.md](GOVERNANCE.md). Security reports follow [SECURITY.md](SECURITY.md); do not open a public issue for a vulnerability.

## License

Apache-2.0. See [LICENSE](LICENSE).

Nothing in this repository is called a "standard". Until the conformance suite ships (Phase 3), the correct description is "open protocol + reference implementation".
