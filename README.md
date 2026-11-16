# ChronosCtx

**A universal stateful context OS and time-travel harness for LLM coding agents.**

ChronosCtx gives a coding agent a durable, versioned memory of a project — what was decided, what was tried and failed, what the code looked like when a decision was made — and the ability to restore both the files *and* the reasoning state to an earlier point.

> **Status: Phase 0 complete. This repository currently contains a measurement spike and the architecture roadmap, not the product.**
>
> `docs/phase0/REPORT.md` holds the feasibility verdict: **GO for Phase 1, conditional on amendments A1–A8**, which `roadmap.md` v1.3 adopts. No daemon, schema, MCP server, or extension exists yet — that is Phase 1 onwards.

---

## What Phase 0 set out to answer

The roadmap gated four months of work behind nine measurable kill criteria (K1–K9). Phase 0 built one rig per question and measured it on two hosts, rather than estimating:

| Question | Verdict |
| --- | --- |
| Can checkpointing be automatic and cheap? | **No, not with `git add -A`.** 109.8 ms p95 on Linux, 1,160 ms on Windows against a 60 ms budget. An incremental, watcher-driven manifest is 6.7 / 27.8 ms. |
| Does identical content produce identical hashes across OSes? | **Yes for content** (7/9 cases, including sha256 repos and CRLF worktrees with shadow attributes); symlinks and case-only collisions must be refused. |
| Is rewind safe and fast? | **Safe.** Both type-conflict directions, three crash points resumed to a verified tree. Fast only with changed-path checkout (163.5 ms Linux vs 492.7 ms). |
| Do the token budgets hold? | **No.** The 7 tool schemas cost 1,444 tokens *with every description deleted*; a reduced contract is 663. A 300-node index is 183 tokens with counts-only groups, 387 with summaries. |
| Does paging actually save tokens? | **66.0 % raw — but −44.4 % once prompt caching is priced in.** The claim is bounded context growth, not cheaper tokens. |
| Does the supply-chain model survive? | **Yes.** `npx` resolves 1 package, 0 transitive, 0 lifecycle scripts — proven with a hostile-package control. |
| Does a web adapter work? | **16/16 behaviours on fixtures.** Live-site validation is Phase 5 evidence and is not claimed. |

The uncomfortable numbers are in the report, not softened: `docs/phase0/REPORT.md`.

---

## Layout

```
roadmap.md                  # v1.3 — architecture, schemas, plan, gates, deltas
docs/phase0/REPORT.md       # the Phase 0 verdict, gate by gate
docs/phase0/METHOD.md       # how every number was produced, and its confounds
docs/adr/0025-supply-chain-model.md
docs/adr/0026-snapshot-mechanism.md
bench/                      # the measurement harness (the only survivor of Phase 0)
  checkpoint.mjs            # git recipe, cold/warm, spawn floor, 2k and 20k
  manifest.mjs              # incremental manifest vs full scan, restore
  rewind.mjs                # §4.4.4 restore, type conflicts, crash resume
  determinism.mjs           # 9-case cross-OS matrix + compare mode
  alternates.mjs            # sha1/sha256 alternates preconditions
  tokens.mjs                # tool surface, boot index, net-token model
  adapter.mjs               # 4 sites × input/output/submit/stream-end
  supplychain.mjs           # scope, closures, install contract + control
  swap.mjs                  # gate 0.12 swap measurements
  summary.mjs               # prints every artifact as one table
  results/                  # committed evidence — every number above
```

---

## Reproducing

Node ≥ 22.15 and git ≥ 2.30.

```bash
npm install --ignore-scripts     # js-tiktoken + jsdom, both dev-only
npm run bench:tokens             # fastest gate; no fixtures needed
npm run bench:adapter
npm run bench:determinism
npm run bench:rewind
npm run bench:checkpoint
npm run bench:manifest
npm run summary                  # one table of every artifact
```

Fixtures are generated deterministically into `CHRONOS_P0_ROOT` (default: the OS temp directory) and never touch this repository. `bench:supplychain` and `bench:swap` install packages into `bench/.deps/` — they are opt-in because they hit the registry.

Cross-OS comparison needs both sides:

```bash
node bench/determinism.mjs --out bench/results/win32-determinism.json
node bench/determinism.mjs --out bench/results/linux-determinism.json --compare bench/results/win32-determinism.json
```

Full method, hosts, and confounds: `docs/phase0/METHOD.md`.

---

## Two things worth knowing before reading the numbers

1. **Windows figures are host-bound.** Real-time Defender scanning and per-process cost (73 ms for `git --version`) dominate them. The harness reports a spawn floor beside every series so design cost and host cost stay separable.
2. **The token model is a model.** Phase 0 had no working agent, so the 8-turn scenario is computed from named constants written into `bench/results/tokens.json` — and reported both raw and cache-adjusted, because prompt caching reverses the sign.

---

## License

Apache-2.0. See [LICENSE](LICENSE).

Nothing in this repository is called a "standard". Until the conformance suite ships (Phase 3), the correct description is "open protocol + reference implementation".
