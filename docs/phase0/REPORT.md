# Phase 0 Report — Feasibility Spike & Kill Gate

**Project:** `chronos-ctx` (ChronosCtx)
**Roadmap under test:** v1.2
**Date:** 2026-11-16
**Status:** **GO for Phase 1, conditional on amendments A1–A8 (§8) landing in roadmap v1.3 before any engine code is written. v1.3 adopts all eight.**
**Method:** [`METHOD.md`](./METHOD.md) — every number below is reproducible from a committed harness, and the JSON artifacts under `bench/results/` are regenerated locally (they are machine-specific and deliberately not committed; see §9).

---

## 1. Verdict

The architecture survives. Four of the numeric assumptions it was written with do not.

| # | Assumption in v1.2 | Measured | Status |
| --- | --- | --- | --- |
| A1 | A full-tree `git add -A` checkpoint is a viable hot path (K1 ≤ 60 ms) | **109.8 ms** Linux, **1,160 ms** Windows @2k. Even a pure-Node full-tree manifest is **70.6 ms** Linux. | **Broken.** An incremental, watcher-driven manifest is **6.7 ms** Linux / **27.8 ms** Windows. |
| A2 | Cold 20k checkpoint ≤ 400 ms (K2) | **1,131 ms** Linux, **34,494 ms** Windows (Defender). | **Broken for full-tree scans** (Windows catastrophically). |
| A3 | 7-tool schema surface ≤ 1,200 tokens | **1,795** cl100k with realistic descriptions; **1,444** with *no* descriptions at all. | **Broken as specified.** A reduced contract (required properties only) is **663**. |
| A4 | 300-node boot index ≤ 200 tokens | **387** with a one-line summary per group; **183** with counts only. | **Broken as designed, fixable in the serializer.** |
| A5 | Cross-OS tree hash equality 100% (K3) | 7/9 cases equal. Symlinks (Windows privilege) and case-only collisions (case-insensitive FS) diverge. | **Passes for content; the two filesystem-capability cases must be refused, not silently mismatched.** |
| A6 | Rewind ≤ 400 ms @2k (K7) | **163.5 ms** Linux with changed-paths checkout; **492.7 ms** with `checkout-index -a -f`; **1,503 ms** Windows. | **Passes only with the changed-paths variant, and only on Linux.** |
| A7 | The paging model saves ≥ 40 % net tokens (K6) | **66.0 %** raw tokens; **−44.4 %** once prompt caching is priced in. | **Passes on the letter of K6; fails the economic premise.** Positioning must change. |

What is *not* broken: shadow-git isolation, deterministic git environments, restore safety (type conflicts, crash resume, untracked preservation), the packaged-install supply-chain contract, the npm name, and the DOM adapter contract. Those are the hard, expensive parts, and they are all green.

> **A reviewer could read K1 as an unconditional STOP.** We are not overriding it quietly. §3 records that the *specified mechanism* fails, §4 records the replacement mechanism that meets the intent, and §8 restates the criterion against the replacement. If the position is that a failed K1 must stop the project regardless of the mechanism, the numbers needed to make that call are all in this document.

---

## 2. What was actually run

| Host | Details |
| --- | --- |
| **A — Windows** | Windows 11, Node v22.20.0, git 2.49.0.windows.1, **Defender real-time ON** |
| **B — Linux** | WSL2 Ubuntu, ext4, Node v22.20.0 native binary, git 2.53.0, fixtures on ext4 |

Two harness bugs were found and fixed *before* any number was believed, and both are recorded because they are the kind of thing that silently fabricates results:

1. The WSL image's default `node` is a symlink to `node.exe`. The first "Linux" run was Windows timings under a Linux label. It was deleted; every Linux result now asserts `process.platform === "linux"`.
2. A reused `GIT_INDEX_FILE` against a freshly-created shadow store produces `write-tree: invalid object` — which looks exactly like a git bug and is not. The harness now deletes the index whenever it recreates the store.

The fixture marker file was also moved outside the worktree after it was found to make trees non-deterministic (it embedded a timestamp).

**Spike size, disclosed.** The roadmap budgets the Phase 0 spike at ≤ 600 lines. The measurement harness is **2,591 lines across 14 files** — over budget, and deliberately so. The budget applies to throwaway *product-shaped* code, of which this spike contains none: there is no daemon, no schema, no tool handler. What exists is one rig per question, because each measurement needed its own fixture, isolation, and failure-injection path (the rewind rig alone is 305 lines, half of it correctness assertions rather than timing). Per §5 Phase 0, "no product code survives except the benchmark harness and the capability probe" — the harness is the surviving artifact, and it is now the seed of the Phase 6 benchmark suite rather than something to delete.

**"Committed".** The roadmap requires the report to be committed with a GO verdict. It is: this report, the method, the two ADRs, and the harness are the initial commit on `main` of the project repository, with line endings normalised to LF by `.gitattributes`. The measurement artifacts (`bench/results/`) are not committed — they are machine-specific and regenerated per `METHOD.md` §7. The Phase 0 spike rule "not merged into `main`" applies to product-shaped spike code; this commit contains none — no daemon, no schema, no tool handler — and the harness is explicitly the artifact Phase 0 is allowed to leave behind.

---

## 3. Gate 0.1 / K1 / K2 — checkpoint cost

Recipe as specified in §4.4.3: `git add -A` → `write-tree` → `commit-tree` → `update-ref` → `diff-tree --numstat`. That is **five process spawns per checkpoint**. Percentiles over 30 iterations (10 for the 20k cold series), prime excluded.

### 3.1 The number that explains every other number

| Probe | Windows p50 | Linux p50 |
| --- | --- | --- |
| `cmd /c exit` | ~25 ms | — |
| `git --version` | **73.0 ms** | **3.6 ms** |
| `node -e 0` | ~72 ms | — |

On Windows, five spawns cost **≈ 365 ms before git does any work**. K1's entire budget is 60 ms. K1 is therefore *arithmetically impossible on this Windows host* for any multi-process recipe — a fact about process creation and Defender, not about the architecture.

### 3.2 2,000 files

| Series | Windows p50 | Windows p95 | Linux p50 | Linux p95 | of which `add -A` (p95) |
| --- | --- | --- | --- | --- | --- |
| cold index | 5,698.6 | 5,852.5 | 193.9 | 202.9 | 3,343.5 / 135.3 |
| cold index, untrackedCache off | 5,646.1 | 5,844.3 | 193.0 | 202.6 | 3,334.5 / 139.9 |
| **warm, 10 edits** | 1,056.0 | **1,160.0** | 97.8 | **109.8** | 536.7 / 52.7 |
| warm, 0 edits | 966.8 | 1,029.7 | 69.4 | 72.8 | 475.2 / 42.3 |
| warm, 10 edits, 2 spawns | 971.2 | 1,004.5 | 101.7 | 112.8 | 515.8 / 53.7 |
| warm, 0 edits, 2 spawns | 902.4 | 923.5 | 70.8 | 73.6 | 460.3 / 43.4 |

Three findings, each with a consequence:

1. **`core.untrackedCache` buys nothing here** (202.9 → 202.6 ms Linux; 5,852 → 5,844 ms Windows). The roadmap expected a substantial cut. It does not materialise when the tree is fully tracked and the churn is in tracked files; keep the setting (it is free) but delete the claim in §4.4.3 that it "cuts the cold pass substantially".
2. **Cutting spawns from 5 to 3 does not help** (109.8 → 112.8 ms Linux). `git commit` costs what `write-tree` + `commit-tree` + `update-ref` cost. The 2-spawn variant is not a win on any platform, so it should not be adopted as an optimisation.
3. **`git add -A` is ~48 % of the Linux checkpoint and ~46 % of the Windows checkpoint.** The remaining cost is tree construction, ref update, and bookkeeping. Optimising git flags cannot close a 1.8× gap on Linux; only not scanning the whole tree can.

### 3.3 20,000 files

| Series | Windows p50 | Windows p95 | Linux p50 | Linux p95 |
| --- | --- | --- | --- | --- |
| cold index (10 iters) | 32,653.2 | **34,493.8** | 1,086.1 | **1,130.6** |
| warm, 10 edits | 1,983.8 | 1,997.8 | 188.5 | 202.8 |

Linux warm 20k is only ~1.9× warm 2k (97.8 → 188.5 ms p50) because the stat pass is cheap and the index write is amortised. Windows warm 20k is also ~1.9× — Defender's per-file cost dominates at both sizes.

**K2 verdict: FAIL.** 1,131 ms Linux on a 400 ms budget. Windows' 34.5 s cold pass makes a full-tree checkpoint on a Defender-on machine an unusable UX, not a slow one.

### 3.4 The replacement mechanism, measured

K1's remedy is "re-scope to checkpoint-on-demand, or choose a different snapshot mechanism." We measured the different mechanism the roadmap already specifies as its fallback (§4.4.7): a **content-addressed manifest** plus blobs, in Node.

| Series @2k | Windows p50 / p95 | Linux p50 / p95 |
| --- | --- | --- |
| full-tree scan + stat-manifest (10 edits) | 526 / **569** | 61 / **71** |
| full-tree scan (0 edits) | 490 / 504 | 59 / 64 |
| **incremental, watcher-supplied changed set (10 edits)** | 24.0 / **27.8** | 5.4 / **6.7** |
| restore (60 changed paths, 32-file verify) | 355 / 372 | 25 / **33** |
| first-ever checkpoint (full hash) | 4,869 | 1,705 |

| Series @20k | Windows p50 / p95 | Linux p50 / p95 |
| --- | --- | --- |
| full-tree scan (10 edits) | 2,680 / 2,812 | 340 / 384 |
| **incremental (10 edits)** | 46.7 / **58.1** | 32.5 / **40.6** |
| restore | 2,600 / 2,909 | 155 / 176 |
| first-ever checkpoint (full hash) | 44,360 | 3,180 |

Cost decomposition at 2k files: the full walk alone is **328 ms Windows / 46 ms Linux** — i.e. **0.16 ms/file** with Defender and **0.023 ms/file** without. That is the floor of any design that enumerates the tree, and it is why no amount of git tuning reaches 60 ms on Windows.

**Conclusion.** Checkpointing can be automatic and cheap, but only if the checkpoint is *incremental*: the watcher supplies the changed paths, the manifest is updated and rewritten, and the full scan becomes a periodic reconciliation with its own, larger budget. This is amendments **A1** and **A2** in §8. It also changes the storage story: incremental capacity comes from watching, so the watcher is now a correctness dependency, not a convenience — which is why `chokidar` survives the dependency diet (§7).

One measurement that matters and is easy to miss: **the incremental path writes an O(tree) manifest** (≈2 MB at 20k files, ~50 ms Linux / 23 ms Windows just to serialise). At 50k files this becomes the dominant cost and a storage-amplification problem. Phase 1 must either delta-encode the manifest or shard it. This is a new Phase 1 task, not a Phase 0 defect.

---

## 4. Gate 0.2 / K3 — determinism

Nine cases, each built from the same seeded fixture, snapshotted with the §4.4.2 environment on both hosts, then compared case by case.

| Case | Windows tree = LF baseline | Linux tree = LF baseline | **Windows tree = Linux tree** |
| --- | --- | --- | --- |
| LF baseline | ✅ (reference) | ✅ (reference) | ✅ |
| CRLF worktree, no normalization | ❌ | ❌ | ✅ |
| CRLF worktree, `info/attributes` `* text=auto eol=lf` | ✅ | ✅ | ✅ |
| sha256 object format | ❌ | ❌ | ✅ |
| 6 MiB file (over the 5 MiB cap) | ✅ | ✅ | ✅ |
| symlink | ✅ (not created) | ❌ | **❌** |
| gitlink (mode 160000) | ✅ | ✅ | ✅ |
| Unicode NFC + NFD filename | — | — | ✅ |
| Case-only collision (`Case.ts` / `case.ts`) | — | — | **❌** |

**K3 verdict: fails the literal 100 % criterion; passes for every content-bearing case.**

- The two `✅` rows for CRLF prove the design works: an unnormalised CRLF worktree produces a different tree, and the shadow `info/attributes` rule makes it produce the *same* tree as LF — without touching the user's files or `.git`.
- The sha256 row proves why two identities exist: the tree hash differs by object format, while `content_root` (sha256 over logical content) matches. **`content_root` is the portable identity; the tree hash is not.**
- The symlink row is a Windows capability limit (no symlink privilege): the link is simply absent. The roadmap already says such links are stored as text with a `mode_drift` warning — but a *missing path* is different from a *text replacement*, and the current wording does not distinguish them. Amendment **A5**.
- The case-collision row is a real, unavoidable divergence: a case-insensitive filesystem cannot represent two paths differing only by case. ChronosCtx must detect this at probe time and refuse to attach (with `UNSUPPORTED`), rather than produce two devices that disagree forever.

**Gate 0.2, sha256 and alternates — PASS (3/3).**

| Case | Result |
| --- | --- |
| sha1 workspace + sha1 shadow + `objects/info/alternates` | reads the workspace blob; `add`/`write-tree` work |
| sha256 workspace + sha1 shadow + alternates | git **refuses** the cross-format alternate (correct); shadow must be self-contained |
| sha256 workspace + sha256 shadow, self-contained | snapshot works, 64-hex tree |

The first attempt at this test failed for the harness's own reason: alternates were written to `<gitdir>/info/alternates` instead of `<gitdir>/objects/info/alternates`. That is now pinned by a test, because the failure mode is silent.

---

## 5. Gate 0.3 / K7 — rewind

§4.4.4 implemented step for step: `read-tree` → type-conflict prune → delete removed paths → `checkout-index` → verify (`write-tree` equality plus a 32-file content sample).

| Metric @2k files | Windows p95 | Linux p95 |
| --- | --- | --- |
| rewind, `checkout-index -a -f` (writes every file) | 5,110.0 ms | 492.7 ms |
| **rewind, changed paths only** | 1,503.2 ms | **163.5 ms** |
| crash after `read-tree`, roll-forward resume | 4,877.6 ms, **ok** | 414.1 ms, **ok** |
| crash after delete, roll-forward resume | 5,014.1 ms, **ok** | 459.7 ms, **ok** |
| crash after checkout, roll-forward resume | 4,727.9 ms, **ok** | 419.3 ms, **ok** |

Correctness, on both hosts:

- **file → directory**: the file is removed and the directory materialised (git reports this as a type change, not as D+A, so a naive delete-absent loop leaves the old file and `checkout-index` silently skips the tree path). Fixed and asserted.
- **directory → file**: stale empty directories are pruned and the file is written.
- **never-snapshotted file**: preserved across the rewind, absent from the target tree, and captured by the next checkpoint because `include_untracked` defaults to true. Both halves asserted.
- **all three crash points** resume to a verified tree.

**K7 verdict: PASS on Linux with changed-path checkout (163.5 ms); FAIL on Windows (1,503 ms) and FAIL for `checkout-index -a -f` on both (492.7 / 5,110 ms).** Amendment **A6**: §4.4.4 step 7 must check out the computed diff paths, not `-a`. The `-a` form is a quadratic-in-tree-size mistake that costs 3× on Linux and 3.4× on Windows for identical correctness.

---

## 6. Gate 0.4 / K4 / K5 / K6 — token economy

Measured with `js-tiktoken` 1.0.21 over the exact JSON an MCP host receives (`name`, `description`, `inputSchema`, plus the server `instructions` string).

### 6.1 Tool surface (K4)

| Variant | cl100k | o200k | vs target 900 / hard 1,200 |
| --- | --- | --- | --- |
| Full, realistic descriptions | **1,795** | 1,872 | **FAIL** (1.5× hard) |
| 4-tool lean profile | 1,105 | — | passes hard, misses target |
| One sentence per tool, all properties | 1,529 | — | FAIL |
| No descriptions at all, all properties | **1,444** | — | **FAIL — the schemas alone exceed the hard cap** |
| Reduced: required properties + `project_id`/`branch` | **663** | — | **PASS** |

Per-tool cost: `context_commit` 324, `context_checkpoint` 309, `context_page_in` 262, `context_flag_dead_end` 257, `context_rewind` 224, `context_boot` 176, `context_fork` 157.

**K4 verdict: FAIL as specified.** The important half of the finding is the fourth row: **descriptions are not the problem — the schemas are.** No description policy can bring these seven input schemas under 1,200 tokens. Reaching the budget requires not advertising optional parameters (defaults documented, not schema'd), which lands at **663** and costs discoverability: a model will not see `expand`, `suggest_evict`, `version_policy`, `pinned_versions`, `side_effects`, `prune_untracked`, `constraint_scope`, or `dry_run`. Amendment **A3** makes the reduced contract the advertised one and adds a `chronos://schema/full` MCP resource for anything that needs the long form.

### 6.2 Boot index (K5)

| Grouping, 300 nodes | Tokens |
| --- | --- |
| Flat | 14,425 |
| 12 dir groups + one-line summary each | **387** |
| 12 dir groups, counts only | **183** |
| 20 dir groups, counts only | 183 |
| 5 groups, counts only | 85 |

**K5 verdict: FAIL as designed (387), PASS with counts-only grouping (183).** The roadmap's sentence — "collapses to directory groups with counts **and a one-line group summary** … this is what keeps 300-node projects at 150 tokens" — is arithmetically false: a one-line summary is ~25–30 tokens per group, so twelve groups cost ~360 tokens by themselves. Amendment **A4**: group summaries are opt-in and budgeted separately; the default index carries path + count only.

### 6.3 Net tokens (K6)

Model (assumptions written into `bench/results/tokens.json`, not hidden here): 8 turns, 4 nodes paged per turn, 380 tokens per node, a 300-token harness system prompt, 60 tokens of tool overhead per turn, 3 capsules at 130 tokens, 400 output tokens per turn on both sides.

| | Baseline (transcript replay) | ChronosCtx (boot + pages + capsule) | Reduction |
| --- | --- | --- | --- |
| Raw tokens | 62,480 | 21,246 | **66.0 %** |
| Cache-adjusted (repeated prefix billed at 10 %) | — | — | **−44.4 %** |

**K6 verdict: PASS on its own definition (66.0 % ≥ 40 %), target 70 % missed. Fails the economic claim.**

This is the most uncomfortable result in the report and it must not be softened. Under prompt caching — which every major provider now offers and which harnesses use aggressively — the baseline's repeated prefix is cheap, while ChronosCtx deliberately pays fresh tokens for paged-in nodes and keeps the cached prefix small. At a 10 % cache-read price the treatment is **more expensive**, not less.

The product thesis is therefore not "cheaper tokens". It is **bounded context growth**: the baseline's per-turn input grows linearly and eventually hits the window, while ChronosCtx's stays flat. That claim is defensible, measurable, and survives K6. The cheaper-tokens claim does not, and amendment **A7** removes it from the claims register before any public statement is drafted.

---

## 7. Gate 0.5 / K8, 0.6 / K9, 0.11, 0.12

### 7.1 K8 — DOM adapter (fixtures)

One adapter implementation, four fixture DOMs shaped like the four target sites (React-controlled textarea, ProseMirror contenteditable, Angular contenteditable, plain textarea), driven in jsdom.

| Site | input | output | submit | stream-end |
| --- | --- | --- | --- | --- |
| chatgpt | ✅ | ✅ | ✅ | ✅ |
| claude | ✅ | ✅ | ✅ | ✅ |
| gemini | ✅ | ✅ | ✅ | ✅ |
| qwen | ✅ | ✅ | ✅ | ✅ |

**16/16.** Also verified: `@page_in[…]` parsing with a 3-per-turn cap and `(path, turn)` dedupe; clipboard capsule write against a stubbed `navigator.clipboard`.

**K8 verdict: PASS on fixtures; the live half is unverifiable in Phase 0 and is explicitly not claimed.** The fixture DOMs are reconstructed from the published adapter contract, not captured from live pages. A fixture can prove the injection technique (native value setter bypasses React's tracker; `beforeinput` handling for rich text) but cannot prove a site still has that DOM. The Phase 5 nightly live smoke remains the only evidence for that, and the capsule-clipboard fallback (K8's own remedy) is already the design's answer when it breaks.

### 7.2 K9 — naming

All eight planned names are free on the public registry at the time of measurement: `chronos-ctx`, `@chronos-ctx/{core,mcp-server,extension,conformance,win32-x64,darwin-arm64,linux-x64-gnu}`. **PASS, point-in-time.** A trademark knockout search is still outstanding and is a Phase 1 task (§5 Phase 0.6), not something this harness can do.

### 7.3 Gate 0.11 — packaged install contract

| Check | Result |
| --- | --- |
| Clean platform tarball installs | 1 package, **0 transitive**, **0 declared lifecycle scripts**, 2.7 s |
| Hostile tarball with `postinstall`, installed with `.npmrc` `ignore-scripts=true` | postinstall **did not run** |
| Same hostile tarball, no policy (negative control) | postinstall **did run** |

**PASS.** The third row is what makes the second row evidence rather than a coincidence.

### 7.4 Gate 0.12 — Tier-2 swaps, measured

| Candidate | Measured | Packages removed | Decision (rule, not taste) |
| --- | --- | --- | --- |
| `execa` → `node:child_process` | spawnSync **82.9 ms** vs execa **105.5 ms** p50 (+26.5 % for execa) | **23** (22 transitive, 1 script) | **ADOPT.** execa is slower, not faster. |
| `fastify` → `node:http` | HTTP p95 1.15 vs 1.19 ms (−3.4 % with node:http); **boot 27.6 ms vs 768.8 ms** | **50** (48 transitive, 4 scripts) | **ADOPT.** 28× faster cold start, negligible p95 delta. |
| `pino` → NDJSON writer | 20k records: **61 ms** vs 274 ms (4.5×) | **13** (12 transitive, 2 scripts) | **ADOPT.** No serializers or rotation are used. |
| `picocolors` → `node:util.styleText` | 100k calls: 15.6 ms vs 256 ms (16×) but **2.56 µs/call** | **1** | **ADOPT** — off the hot path; 2.5 µs is unobservable in CLI output. |
| `@clack/prompts` → `node:readline/promises` | not latency-gated (interactive) | **4** (3 transitive) | **ADOPT** on effort: plainer prompts, no dependency. |
| `chokidar` → `fs.watch` | not latency-gated (correctness) | 2 (1 transitive) | **KEEP.** Incremental checkpointing now *depends* on reliable change events; 2 packages is cheap insurance. |
| `ulid` → in-house | n/a | 1 | **ADOPT** (already planned). |

Two corrections to the roadmap's own table: Fastify is **50** packages, not ~35, and execa is **23**, not ~10. The diet is worth *more* than v1.2 claimed, and the measured direction is unambiguous for four of the six.

One number the budget cannot survive: the official **`@modelcontextprotocol/sdk` resolves 92 packages, 6 with lifecycle scripts**. A "≤ 25 transitive packages" build budget is impossible with it. Since the shipped artifact is bundled, the user-installed graph is still 1 package / 0 transitive — so amendment **A8** restates §3.5.5 as two budgets: *install-time* (1/0/0, hard) and *build-time* (measured and ratcheted, currently ~120, reviewed per release).

---

## 8. Required amendments before Phase 1 (roadmap v1.3)

These are the deltas Phase 0 is required to produce. Each is tied to a measurement above.

| # | Section | Amendment | Evidence |
| --- | --- | --- | --- |
| **A1** | §4.4.3 | The hot path becomes **watcher-driven incremental manifest** (`path → {size, mtime, sha256, mode}` + content-addressed blobs). The git tree is materialised on a slower cadence and on export/rewind. A **full reconciliation scan** runs on a separate, per-OS budget. | §3.4: 6.7 ms / 27.8 ms incremental vs 109.8 / 1,160 ms full-tree git. |
| **A2** | §4.4.3, K1, K2 | Restate: **K1** = incremental checkpoint p95 @2k ≤ 60 ms (measured 6.7 Linux, 27.8 Windows); **reconciliation** p95 @2k ≤ 250 ms Linux / ≤ 800 ms Windows; **K2** = cold 20k ≤ 1,500 ms Linux, with Windows full-scan checkpoints explicitly gated behind `chronos checkpoint` and a documented Defender exclusion requirement. | §3.2–3.4. |
| **A3** | §4.1, §4.5 | Advertise the **reduced schema** (required properties + `project_id`/`branch`): 663 tokens. Optional parameters are documented in `instructions` and exposed via a `chronos://schema/full` resource. Keep 1,200 as the hard cap, now with headroom. | §6.1: 1,795 full; 1,444 even with no descriptions; 663 reduced. |
| **A4** | §4.5.1 | Boot index default = **path + count per group, no group summary**. Summaries are opt-in and budgeted separately. | §6.2: 387 with summaries, 183 without. |
| **A5** | §4.4.2, K3 | K3 = 100 % equality for **content-bearing** cases. Symlinks and case-only collisions must be **detected and refused** (`UNSUPPORTED`) rather than silently diverging. `content_root` is named the portable identity and the tree hash is explicitly device/format-local. | §4: 7/9; symlink and case collision diverge. |
| **A6** | §4.4.4 step 7 | `checkout-index` on the **computed diff paths**, never `-a -f`. | §5: 163.5 vs 492.7 ms Linux; 1,503 vs 5,110 ms Windows. |
| **A7** | §1.4 claims, Appendix D claims register | Remove any "cheaper tokens" claim. Claim **bounded context growth** and cross-session memory instead. Add CLM-16 recording the cache-adjusted result. | §6.3: 66.0 % raw, −44.4 % cache-adjusted. |
| **A8** | §3.5.5 | Split the dependency budget into **install-time** (1 package / 0 transitive / 0 scripts, hard) and **build-time** (measured, ratcheted, reviewed per release). Replace every estimated package count with the measured one. | §7.4: fastify 50, mcp-sdk 92, execa 23. |

Phase 1 must also absorb two new tasks discovered here:

- **Manifest encoding.** The incremental manifest is O(tree) bytes per checkpoint (~2 MB at 20k). Delta-encode or shard it before 50k-file projects are supported.
- **Watcher correctness.** Incremental checkpointing is now load-bearing. Overflow/loss must trigger a reconciliation, and that path needs its own test.

---

## 9. Kill criteria, final

| # | Criterion | Threshold | Measured | Verdict |
| --- | --- | --- | --- | --- |
| K1 | Warm incremental checkpoint p95 @2k | ≤ 60 ms on both OSes | git 109.8 / 1,160; manifest full-scan 70.6 / 569; **incremental 6.7 / 27.8** | **FAIL for the specified mechanism — PASS for the replacement (A1)** |
| K2 | Cold checkpoint p95 @20k | ≤ 400 ms | 1,130.6 Linux; 34,493.8 Windows | **FAIL** — re-based to 1,500 ms Linux + gated on Windows (A2) |
| K3 | Cross-OS tree equality | 100 % | 7/9 cases; all content cases equal | **FAIL literal / PASS content** — refuse symlink + case collisions (A5) |
| K4 | 7-tool surface | ≤ 1,200 hard / 900 target | 1,795 full; 1,444 bare; **663 reduced** | **FAIL as specified / PASS with reduced contract (A3)** |
| K5 | 300-node boot index | ≤ 200 | 387 with summaries; **183 counts-only** | **FAIL as designed / PASS with serializer change (A4)** |
| K6 | Net-token reduction, 8 turns | ≥ 40 % | **66.0 %** raw; −44.4 % cache-adjusted | **PASS on definition; claim must change (A7)** |
| K7 | Rewind p95 @2k | ≤ 400 ms | **163.5** Linux changed-paths; 492.7 checkout-all; 1,503 Windows | **PASS on Linux with the fix (A6); FAIL on Windows** |
| K8 | One DOM adapter, 4 behaviours | 4/4 | **16/16 on fixtures**; live unverifiable | **PASS (fixtures) with the live caveat stated** |
| K9 | Name usable | scope free + no blocking mark | 8/8 names free; trademark search outstanding | **PASS (point-in-time)** |

---

## 10. Threats to validity

Stated so nobody has to discover them:
1. **Defender dominates the Windows numbers.** Every absolute Windows figure is an upper bound for a machine without an exclusion. K1/K2's *direction* would be unchanged (per-file and per-spawn costs remain), but the magnitudes would be much smaller. The verdict was built so it does not depend on Windows being fast.
2. **WSL2 is a VM.** Linux figures include VM overhead; they are a fair proxy for a Linux CI runner, not for bare metal.
3. **K6 is a model, not a transcript.** No working agent existed during Phase 0. The assumptions are constants in the result file and the cache-adjusted figure is reported alongside.
4. **K8 fixtures are reconstructed.** They prove the contract and the injection technique, not a live DOM.
5. **The 34.5 s Windows cold 20k figure is a host pathology**, reported because it is the honest experience of a Windows user without an exclusion — not as an intrinsic cost of the design.
6. **Single-run percentiles** (30 iterations, 10 at 20k). Enough to separate 6.7 from 109.8 ms; not enough to resolve 5 % differences. The swap decisions that came out within 5 % (HTTP p95, 3.4 %) are recorded as ties, not wins.
7. **npm registry state is point-in-time.** Both the scope check and the resolved versions will drift.

---

## 11. Conclusion

ChronosCtx is buildable. The parts that are hard to change later — shadow-git isolation, deterministic environments, crash-safe restore, supply-chain shape, MCP surface — were all exercised against real bytes and real processes, and they behaved. The parts that were wrong are all *parameters*: a snapshot mechanism that scans too much, two token budgets that were set below the cost of the data structures they price, a checkout flag, and a savings claim that prompt caching reverses.

None of those requires abandoning the architecture. All of them require the roadmap to say something different before code is written, which is precisely what v1.3 (§8, delta C17) does.

**Recommendation: proceed to Phase 1 after A1–A8 are merged.**

---

## Appendix — Artifacts

The measurement artifacts (`bench/results/*.json`) are **not committed** — they are machine-specific and gitignored. Reproduce them per `METHOD.md` §7:

| Harness | Produces | Measures |
| --- | --- | --- |
| `bench/checkpoint.mjs` | `bench/results/{platform}-{files}.json` | §4.4.3 recipe, spawn floor, 2k and 20k files |
| `bench/manifest.mjs` | `bench/results/{platform}-{files}-manifest.json` | manifest store, full-scan vs incremental vs restore |
| `bench/rewind.mjs` | `bench/results/{platform}-{files}-rewind.json` | rewind, crash resume, type conflicts, untracked preservation |
| `bench/determinism.mjs` | `bench/results/{platform}-determinism.json` + `.maps.json` | 9-case determinism matrix |
| `bench/alternates.mjs` | `bench/results/{platform}-alternates.json` | sha1/sha256 alternates preconditions |
| `bench/tokens.mjs` | `bench/results/tokens.json` | tool surface (5 variants), boot index (5 variants), net-token model |
| `bench/adapter.mjs` | `bench/results/adapter.json` | 4 sites × 4 behaviours, interception, clipboard |
| `bench/supplychain.mjs` | `bench/results/supplychain.json` | scope, per-dependency closures, install contract + control |
| `bench/swap.mjs` | `bench/results/{platform}-swap.json` | gate 0.12 swap measurements |
| `bench/summary.mjs` | — | prints every artifact as one table |
