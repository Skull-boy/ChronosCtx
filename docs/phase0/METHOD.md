# Phase 0 — Measurement Method

This file documents **how** every Phase 0 number was produced. It exists so a reviewer can
re-run the harness and get the same result, and so a number that is host-bound is *labelled*
as host-bound rather than presented as a property of the design.

The verdict and the numbers live in `REPORT.md`. This file is the method.

---

## 1. What Phase 0 measures

| Gate | Question | Harness |
| --- | --- | --- |
| 0.1 / K1 / K2 | Is a shadow-git checkpoint cheap enough to run automatically? | `bench/checkpoint.mjs`, `bench/manifest.mjs` |
| 0.2 / K3 | Does identical content produce identical tree hashes across OSes? | `bench/determinism.mjs`, `bench/alternates.mjs` |
| 0.3 / K7 | Can a rewind restore files safely and quickly, including type conflicts and crashes? | `bench/rewind.mjs` |
| 0.4 / K4 | Does the 7-tool MCP surface fit 1,200 tokens hard / 900 target? | `bench/tokens.mjs` |
| 0.4 / K5 | Does a 300-node boot index fit 200 tokens? | `bench/tokens.mjs` |
| 0.4 / K6 | Does the paging model reduce net tokens by ≥ 40% on an 8-turn scenario? | `bench/tokens.mjs` |
| 0.5 / K8 | Does one DOM adapter satisfy input/output/submit/stream-end? | `bench/adapter.mjs` |
| 0.6 / K9 | Is the npm scope free? | `bench/supplychain.mjs` |
| 0.11 | Does the packaged install resolve 1 package and run 0 scripts? | `bench/supplychain.mjs` |
| 0.12 | Which Tier-2 swaps meet the ≤ 10% latency rule? | `bench/swap.mjs` |

Every harness writes a JSON artifact into `bench/results/`. `bench/summary.mjs` prints them all
as one table; `REPORT.md` is written from those artifacts, not from memory.

---

## 2. Hosts

**Host A — Windows (primary developer machine).** Windows 11, Node v22.20.0, git 2.49.0.windows.1, Defender real-time protection ON (exclusions require administrator rights and could not be added).

**Host B — WSL2 Ubuntu (Linux half).** Node v22.20.0 native binary, git 2.53.0, fixtures on ext4.

### Host B was verified, not assumed

The default `node` inside this WSL image is a symlink to `/mnt/c/Program Files/nodejs/node.exe`. A first "Linux" run therefore executed through WSL interop, reported `process.platform === "win32"`, and produced Windows timings with a Linux label. That artifact was deleted.

The Linux numbers in `REPORT.md` come only from a run that printed `process.platform === "linux"` and used a native Linux Node binary, with fixtures rooted on ext4 (`$HOME/p0`), **not** `/mnt/c` (9p). `bench/lib/gitenv.mjs` inherits the root from `CHRONOS_P0_ROOT` for exactly this reason.

Any future run must assert the platform before the numbers are trusted. The harness prints `files on <platform>` as the first line; a mismatched platform is a failed run.

---

## 3. Fixtures

`bench/lib/fstree.mjs` generates content deterministically from a seed, so the Windows and
Linux trees are byte-identical before any line-ending conversion:

- paths are `src/m<i%40>/p<i%97>/f<i>.ts` — a shallow but wide tree, 40 × 97 directory pairs;
- content is a 180–4,378 byte slice of a seeded 1 MiB word pool;
- a fixture is created once and marked with `.chronos-p0-fixture.json`, so a re-run does not
  re-generate 20,000 files;
- `node_modules/`, `.chronos/`, and `*.log` are present in every fixture **and ignored**, so a
  checkpoint that staged them would be caught rather than silently inflating the tree.

Mutation for the "warm, 10 edits" series rewrites 10 pre-existing tracked files per iteration
with a per-iteration salt, so no two iterations checkpoint identical content.

---

## 4. The deterministic git environment

Every git invocation reproduces §4.4.2 exactly, and `bench/lib/gitenv.mjs` is the only place
that builds the environment:

```
GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE   → the shadow store, outside the workspace
GIT_AUTHOR_* / GIT_COMMITTER_*             → fixed identity
GIT_AUTHOR_DATE / GIT_COMMITTER_DATE       → fixed ISO-8601 UTC
GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=NUL (win32) / /dev/null
GIT_TERMINAL_PROMPT=0, LC_ALL=C, LANG=C
core.autocrlf=false, core.eol=lf, core.fileMode=false, core.precomposeUnicode=true
core.bare=false, core.worktree=<ws>, core.untrackedCache=<on|off>
core.fsmonitor=false, gc.auto=0, commit.gpgsign=false, index.version=4
```

`core.untrackedCache` is toggled per series so its effect is measured, not assumed.

The shadow repo is created as `git init --bare` and then flipped to `core.bare=false` with an
explicit `core.worktree`, which is what allows `git add` against a work tree that has no `.git`
of its own. The user's repository is never touched: no harness writes a `.git` anywhere except
the fixture's own object store in `bench/alternates.mjs`, which exists to test that case.

---

## 5. What is timed, and what is excluded

- Timing starts **after** fixture generation and after the shadow repo and environment exist.
- Each series performs one **prime** checkpoint first (cold index, every object written) and
  excludes it from the percentiles, except where the prime is itself the measurement.
- "cold index" deletes `GIT_INDEX_FILE` before every iteration; "warm" keeps it.
- Reported statistics are p50/p90/p95/p99/max over 30 iterations (10 for the 20,000-file
  cold series, because each iteration costs tens of seconds on Windows).
- Process-spawn count is counted per checkpoint by a counter inside `git()`, not inferred.
- Peak RSS is the harness process RSS; **child git process peak is not captured**, which
  understates real memory. Noted in the report rather than papered over.

### The spawn floor

On this Windows host, creating *any* process is expensive:

| Probe | p50 |
| --- | --- |
| `cmd /c exit` | ~25 ms |
| `git --version` | 52–76 ms |
| `node -e 0` | ~72 ms |

Because §4.4.3 uses 4–5 process spawns per checkpoint, the spawn floor alone is 200–380 ms on
this host. Every checkpoint result is therefore reported next to `spawnFloor`, and the same
series is run in a 2-spawn variant (`git add -A` + `git commit`) to separate *design cost*
from *host cost*. A budget expressed in milliseconds is meaningless without that floor.

---

## 6. Confounds, stated openly

1. **Defender real-time scanning is on.** Adding an exclusion requires administrator rights
   that this environment does not have. Defender inflates every file open; the effect is
   measurable and large (`git add -A` on 507 unchanged files: ~650 ms cold, ~120 ms warm).
   Windows absolute numbers are therefore **host-bound** and are reported as an upper bound.
2. **WSL2 is a VM.** ext4 timings exclude Windows filter drivers but include VM overhead;
   they are a fair proxy for a Linux CI runner, not for bare metal.
3. **The 20,000-file Windows cold series is dominated by per-file open cost**, not by git's
   algorithms. It is reported as evidence that a full-tree hash on Windows/Defender is not a
   viable hot path, not as a portable performance claim.
4. **`jsdom` is not a browser.** K8 validates the adapter contract and the injection technique
   against reconstructed DOMs; it cannot validate a live site. The adapter harness says so in
   its own JSON (`caveat`), and the report repeats it.
5. **K6 is a model, not a transcript.** Phase 0 has no working agent, so the 8-turn scenario is
   computed from named assumptions (node size, pages per turn, capsule frequency) that are
   written into the result file. Both raw-token and cache-adjusted figures are reported,
   because prompt caching changes the conclusion and hiding that would be dishonest.
6. **The npm scope check is a point-in-time registry query.** It says nothing about tomorrow.

---

## 7. Reproducing

```bash
# Windows
node bench/checkpoint.mjs --files 2000
node bench/checkpoint.mjs --files 20000 --quick
node bench/manifest.mjs   --files 2000
node bench/determinism.mjs
node bench/rewind.mjs     --files 2000
node bench/tokens.mjs
node bench/adapter.mjs
node bench/alternates.mjs
node bench/supplychain.mjs
node bench/swap.mjs

# Linux (WSL, native node, fixtures on ext4)
CHRONOS_P0_ROOT=$HOME/p0 $HOME/node22/bin/node bench/checkpoint.mjs --files 2000 --out bench/results/linux-2000.json
CHRONOS_P0_ROOT=$HOME/p0 $HOME/node22/bin/node bench/checkpoint.mjs --files 20000 --quick --out bench/results/linux-20000.json
node bench/determinism.mjs --out bench/results/win32-determinism.json
node bench/determinism.mjs --out bench/results/linux-determinism.json --compare bench/results/win32-determinism.json

# one table of every artifact
node bench/summary.mjs
```

`bench/determinism.mjs` writes a `.maps.json` sidecar next to each result; `--compare` needs
both platforms' sidecars and produces `*-compare.json`.

---

## 8. What this method cannot establish

- Whether a real Claude Code / OpenCode session saves the modelled number of tokens.
- Whether a live ChatGPT/Claude/Gemini DOM still matches the fixture selectors.
- Whether a Linux server without a VM layer is faster or slower than the WSL2 figures.
- Whether Windows without Defender is fast enough to change the K1 verdict. It probably is —
  which is precisely why the verdict is stated as conditional on the host, and why the design
  recommendation does not depend on Windows being fast.
