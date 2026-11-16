# ADR-0026 — Snapshot mechanism: incremental manifest hot path, git for materialisation

- **Status:** Accepted (Phase 0, 2026-11-16)
- **Supersedes:** the v1.2 assumption that a checkpoint is `git add -A` → `write-tree` → `commit-tree` → `update-ref`
- **Related:** ADR-0004 (shadow repository), ADR-0010 (rewind safety), roadmap §4.4.2–§4.4.4, delta C17
- **Evidence:** `docs/phase0/REPORT.md` §3–§5; `bench/results/{win32,linux}-*-manifest.json`, `bench/results/{win32,linux}-2000.json`, `bench/results/{win32,linux}-2000-rewind.json`

## Context

K1 required a checkpoint to complete in ≤ 60 ms p95 at 2,000 files, on the assumption that a persistent git index makes `git add -A` incremental. Phase 0 measured the recipe directly instead of assuming:

| Mechanism @2k files, 10 edits (p95) | Linux (ext4) | Windows (Defender on) |
| --- | --- | --- |
| `git add -A` → `write-tree` → `commit-tree` → `update-ref` → `diff-tree` | 109.8 ms | 1,160.0 ms |
| same, with `git commit` instead of the three plumbing steps | 112.8 ms | 1,004.5 ms |
| Node manifest store, full tree scan | 70.6 ms | 569.4 ms |
| **Node manifest store, watcher-supplied changed set** | **6.7 ms** | **27.8 ms** |

Two facts decide the ADR:

1. The floor of a full-tree scan is per-file metadata work — **0.023 ms/file** on ext4, **0.16 ms/file** with Defender. At 2,000 files that is 46 ms / 328 ms before anything is hashed or written. K1 cannot be met by a scan, on either OS, at any level of git tuning.
2. On Windows, five process spawns cost ≈365 ms on their own (`git --version` p50 = 73.0 ms). A multi-process recipe starts at ~6× the budget.

`core.untrackedCache` — which v1.2 expected to "cut the cold pass substantially" — measured 202.9 → 202.6 ms (Linux) and 5,852 → 5,844 ms (Windows) when disabled on a fully tracked tree. It is free, so it stays on, but it is not a lever.

## Decision

**The hot path is an incremental, watcher-driven manifest with content-addressed blobs. Git is used to materialise a tree, not to discover what changed.**

1. A filesystem watcher (`chokidar`, `awaitWriteFinish`, overflow-aware) reports changed and deleted paths.
2. For each changed path: `lstat`; if `(size, mtimeMs)` match the previous manifest entry, reuse the hash; otherwise `sha256(content)` and write the blob if absent.
3. The manifest (`path → {size, mtimeMs, mode, hash}`, canonically sorted) is rewritten and hashed to produce `snapshot_id`.
4. On commit to a branch, on export, and before a rewind, the git tree is written **from the manifest** (`write-tree` after an index built from the manifest map) — no rescan of the worktree.
5. A **reconciliation sweep** re-walks the tree on a separate budget (default: 60 s idle, 5 s with an active session, and immediately on watcher overflow) and diffs against the manifest. Any difference raises `WATCHER_DRIFT` with the paths and forces a manifest rebuild before the next checkpoint is trusted.
6. `chronos checkpoint --full` retains the §4.4.3 git recipe for environments with no watcher (network drives, CI containers, locked-down hosts).

Rewind changes one step: `checkout-index` receives the computed diff paths, never `-a -f` (see Consequences).

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Keep `git add -A` and raise the budget to 150 ms | Fails at 20k (188.5 ms warm Linux, 1,984 ms Windows) and makes the budget a function of project size, which is the thing users cannot control. Also leaves Windows unusable. |
| `git commit` 2-spawn variant | Measured no faster (112.8 vs 109.8 ms Linux). `git commit` performs the same work inside one process; the spawn saving is offset by its extra steps. |
| `core.fsmonitor` / watchman | Adds an external daemon the roadmap explicitly refuses to depend on ("never rely on a daemon that may be absent"), and does not address Windows Defender cost. |
| Pure manifest, drop git entirely | Loses git's object model, which is what makes cross-tool export, `checkout-index` correctness, and the 7/9 determinism result possible. Also loses interop with the user's own tooling. |
| Incremental tree updates via `git update-index --index-info` per checkpoint | Requires reading the previous index (a spawn) and still needs `write-tree` + `commit-tree`; measured spawn cost dominates on Windows. Kept as the *materialisation* step, where it is paid once per commit rather than per checkpoint. |

## Consequences

**Positive**

- Checkpoint meets K1 with margin on both platforms (6.7 / 27.8 ms vs 60).
- Checkpoint cost is O(changed) instead of O(tree), so project size stops being a latency tax for the common case.
- Cross-OS portability is preserved: `content_root` is computed from logical content, and the git tree remains available for export and rewind.
- The 20k warm case stays at 40.6 ms Linux / 58.1 ms Windows, so the mechanism scales to the documented `maxFiles = 50,000` without a redesign.

**Negative — accepted and budgeted**

1. **The watcher becomes load-bearing.** A missed event means a stale checkpoint. Mitigated by reconciliation + `WATCHER_DRIFT`, and by making `--full` a first-class fallback. This is a new failure surface, and it gets its own tests.
2. **Manifest writes are O(tree) bytes** (~2 MB at 20k files, ~50 ms Linux). At 50k this becomes dominant and a storage-amplification problem. Phase 1 must delta-encode or shard; this is recorded, not hidden.
3. **Two sources of truth for "what exists"** (manifest and git index) must be reconciled on materialisation. A materialisation test asserts `write-tree` from the manifest equals the tree produced by a full `git add -A`.
4. **First-ever checkpoint is still a full hash** (4.9 s Windows / 1.7 s Linux at 2k) — a one-time cost on project attach, surfaced in `chronos init` progress.
5. **`checkout-index -a -f` is removed from the rewind algorithm.** Measured 492.7 ms vs 163.5 ms (Linux) and 5,110 ms vs 1,503 ms (Windows). Correctness is identical; the flag was a straight 3× penalty.

**Follow-ups owned by Phase 1/2**

- Manifest delta/shard encoding before 50k files are claimed.
- Watcher-overflow tests, including a forced-miss that must be caught by reconciliation.
- Materialisation equivalence test (manifest → tree == `git add -A` → tree) on every CI platform.
- Re-baseline gates 2.2/2.2b/2.3 against the numbers above.

## Verification

- `docs/phase0/REPORT.md` §3 (checkpoint), §5 (rewind).
- Reproduction: `node bench/checkpoint.mjs --files 2000`, `node bench/manifest.mjs --files 2000`, `node bench/rewind.mjs --files 2000`, on both hosts, per `docs/phase0/METHOD.md` §7.
