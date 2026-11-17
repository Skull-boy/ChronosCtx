<div align="center">

<h1>ChronosCtx</h1>

**A stateful context OS and time-travel harness for LLM coding agents.**

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.15-brightgreen.svg)](.nvmrc)
[![Status](https://img.shields.io/badge/status-phase%201%20%C2%B7%20in%20progress-orange.svg)](roadmap.md)

</div>

---

## The problem

Coding agents forget.

A long task leaves behind a transcript where the decision, the failed attempt that led to it, and the evidence that it works all have the same weight: prose in a window that will soon be cleared, compacted, or truncated. Keep the window and the context rots. Clear it and the reasoning is gone.

ChronosCtx treats project knowledge as a **versioned object** instead of conversation history. Decisions live at stable paths, carry evidence, and can be restored together with the files they describe.

```text
agent session ──▶ context_boot        small index, not a transcript
              ──▶ context_page_in     only the nodes this step needs
              ──▶ context_commit      versioned, evidence-labelled
              ──▶ context_checkpoint  reasoning state + file tree, atomically
              ──▶ context_rewind      undo a failed path without losing the lesson
```

## What it gives you

- **Versioned reasoning state.** Every decision is a node at a deterministic path (`auth/jwt-spec`), with an immutable version ledger. Nothing is overwritten; renames keep aliases.
- **Evidence, not vibes.** Nodes are `unverified`, `verified`, or `deprecated`. `verified` requires tree-bound evidence, and freshness is recomputed against the current tree — a proof that no longer covers the code is shown as `stale`, never as truth.
- **Atomic checkpoints.** A snapshot, the node versions it references, the checkpoint row, and the branch head commit in one transaction. There is no visible half-checkpoint.
- **Rewind that is honest.** Drift is refused, writers are quiesced, a backup checkpoint is mandatory, and irreversible side effects are reported instead of pretending they were undone.
- **Branches for hypotheses.** Fork the reasoning state, try the risky approach, merge the winner, and keep the loser as a negative constraint.
- **Bounded context.** Boot ≤ 200 tokens, page-in ≤ 1,200 by default, capsules ≤ 500, all envelope-inclusive and deterministically truncated.
- **A dead-end ledger.** Failed approaches are recorded with their reason and evidence, so the next agent does not repeat them.

Designed as one local daemon with thin MCP proxies, a dedicated shadow git repository, and a libSQL database. No cloud dependency, and no dependency code executed at install time.

## Measured, not asserted

Phase 0 built one rig per question and ran it on two hosts. These are the numbers that shaped the architecture, including the ones that killed the original design.

### Checkpoints and restore

| Operation | Linux | Windows | Budget |
| --- | ---: | ---: | --- |
| Incremental checkpoint, p95 @ 2k files | **6.7 ms** | **27.8 ms** | ≤ 60 ms |
| Reconciliation scan, p95 @ 2k files | **71 ms** | **569 ms** | ≤ 250 / ≤ 800 ms |
| Cold checkpoint, p95 @ 20k files | **1,131 ms** | **34,494 ms** | ≤ 1,500 ms Linux; explicit-command only on Windows |
| Rewind, changed paths only | **164 ms** | **1,503 ms** | ≤ 400 ms Linux |
| `git add -A` per checkpoint @ 2k | 110 ms | 1,160 ms | **rejected** — this is why the manifest exists |

### Context and install

| Measure | Result |
| --- | ---: |
| Full 7-tool surface | 1,795 tokens |
| Reduced contract (required fields + project/branch) | **663 tokens** |
| Full schemas with every description deleted | 1,444 tokens |
| Boot index, counts per group | **183 tokens** |
| Boot index, with summaries | 387 tokens |
| Paging net, raw | **66.0 %** |
| Paging net, cache-adjusted | **−44.4 %** |
| Published artifact install | **1 package, 0 transitive, 0 lifecycle scripts** |
| `node:http` boot vs Fastify | **27.6 ms vs 768.8 ms** |

### Read path (Phase 1)

| Measure | Result |
| --- | ---: |
| Boot index, 300 nodes, counts-only | **≤ 150 tokens** (109 in the reference run: 64 content + 45 envelope) |
| Seven-tool reduced surface | **834 tokens** (target 900, hard 1,200) |
| Lean four-tool surface | **507 tokens** (cap 600) |
| `page_in`, 12 paths | **≤ 1,200 total**, envelope and schema share included |

**Reading the numbers.** Windows figures are host-bound: real-time scanning and per-process cost dominate them, so the harness publishes a spawn floor beside every series. The cache-adjusted paging figure is negative because prompt caching reverses the raw saving, and both are always reported together. The token figures are measured against the actual schemas and fixtures; the paging model is an 8-turn scenario documented in the method.

Full method, hosts, confounds, and every gate: [`docs/phase0/REPORT.md`](docs/phase0/REPORT.md) · [`docs/phase0/METHOD.md`](docs/phase0/METHOD.md).

## Status

**Phase 0 complete. Phase 1 (core state graph engine) in progress.**

| Area | State |
| --- | --- |
| Workspace, schema, migrations, Drizzle parity gate | ✅ |
| IDs, node paths, error contract, budgets | ✅ |
| Projects, branches, node versions, aliases | ✅ |
| `context_commit` core, D1 versioning, optimistic concurrency | ✅ |
| Epistemic gate, evidence rules, tree-bound freshness | ✅ |
| Snapshots, dedupe, state-only checkpoints | ✅ |
| CLI (`migrate`, `doctor`, `project`, `stats`) | ✅ |
| Pager, boot index, tool-surface budget | ✅ |
| Capsule v1 and render hash | next |
| Daemon, loopback security, filesystem probe | next |
| MCP surface, shadow git, rewind, forks | Phase 2 |

Phase 1 has **12 of 18 gates** implemented. The gate runner is authoritative, and pending gates fail the run on purpose:

```bash
node scripts/verify-phase.mjs --phase 0    # 2/2
node scripts/verify-phase.mjs --phase 1    # 12/18 today
node scripts/verify-phase.mjs --list
```

166 unit and property tests currently pass, including 1,000 randomized fork/commit interleavings, 200-checkpoint dedupe, 5,000 generated freshness histories, and a measured 300-node boot index.

## Quickstart

Requires **Node ≥ 22.15**, **git ≥ 2.30**, and corepack (bundled with Node).

```bash
git clone https://github.com/Skull-boy/ChronosCtx.git
cd ChronosCtx

corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm build

corepack pnpm test
node packages/cli/dist/index.js doctor
```

<details>
<summary>If <code>corepack enable</code> cannot write shims</summary>

Some managed Windows installs block writes next to the Node binary. Install the shims inside the repo instead:

```bash
mkdir .tools/bin
corepack enable --install-directory .tools/bin

# bash
export PATH="$PWD/.tools/bin:$PATH"
# PowerShell
$env:PATH = "$PWD\.tools\bin;$env:PATH"
```

`.tools/` is gitignored. Turborepo needs `pnpm` on `PATH`; every other task also runs as `corepack pnpm <task>`.

</details>

### CLI

```bash
node packages/cli/dist/index.js migrate --check       # exit 1 if anything is pending
node packages/cli/dist/index.js project create toy-api -n "Toy API"
node packages/cli/dist/index.js project fork toy-api redis-rate-limit
node packages/cli/dist/index.js boot toy-api         # bounded index
node packages/cli/dist/index.js page-in toy-api --path auth/jwt-spec db/schema
node packages/cli/dist/index.js surface --profile full
node packages/cli/dist/index.js stats --dedupe        # checkpoints vs snapshot rows
```

State lives in `CHRONOS_HOME` (default `~/.chronos-ctx`). Network and synced drives are refused, because a WAL database on a sync client is a corruption generator.

## Repository layout

| Path | Contents |
| --- | --- |
| `roadmap.md` | The normative architecture: schema, tool contracts, phases, gates, decisions. |
| `packages/shared-types` | IDs, node paths, errors, budgets. Zero runtime dependencies, enforced in CI. |
| `packages/core-engine` | Storage, migrations, repositories, epistemic gate, freshness, snapshots, checkpoints. |
| `packages/cli` | The `chronos` command surface. |
| `docs/adr` | Architecture decisions and the alternatives each one rejected. |
| `docs/phase0` | The feasibility report, method, and confounds. |
| `scripts` | Bootstrap, phase gate runner, supply-chain policy, doctor gate. |
| `bench` | The Phase 0 measurement harness, retained as reproducible evidence. |
| `tests` | Cross-package integration, crash, security, and conformance suites. |

## Design principles

1. **Evidence over assertion.** A number ships with its method and artifact, or it does not ship. A limitation is stated, not omitted.
2. **Fail closed on trust.** A missing proof downgrades a claim; it never silently promotes one. Web surfaces cannot self-verify.
3. **Local-first.** The database, the file history, and the reasoning state stay on the user's machine. The published artifact resolves nothing and executes nothing at install time.
4. **One writer, one transaction.** Concurrency is a named refusal (`PROJECT_BUSY`, `WRITE_REJECTED_BRANCH_QUIESCED`), not a silent queue.
5. **Budgets include the envelope.** A response that reports content tokens but hides its JSON and schema overhead is not bounded.
6. **Identical state is stored once.** Snapshots carry a local `snapshot_hash` and a portable `content_root`, so sync can dedupe knowledge without collapsing two real histories.

## Documentation

- [Roadmap](roadmap.md) — the full design, including the rejected alternatives.
- [ADRs](docs/adr/README.md) — why each locked decision was made.
- [Phase 0 report](docs/phase0/REPORT.md) — the measurements and the GO verdict.
- [Supply-chain model](docs/adr/0025-supply-chain-model.md) — why installs execute nothing.
- [Security policy](SECURITY.md) — private disclosure, 72-hour acknowledgement, supported versions.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first: it lists the rules that are actually enforced (DCO sign-off, no host details or personal data in tracked files, no direct writes to epistemic state, a gate for every new behaviour). Governance and the RFC process are in [GOVERNANCE.md](GOVERNANCE.md).

## Security

Do **not** open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md); GitHub private vulnerability reporting is the primary channel.

## License

Apache-2.0. See [LICENSE](LICENSE).

The project name, logo, and compatibility claims are governed by the license's trademark clause. Nothing here is called a "standard"; until the conformance suite ships, the correct description is **open protocol + reference implementation**.
