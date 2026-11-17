# ADR-0004 — Dedicated shadow git repository; `home` vs `portable` object store

- **Status:** Accepted (Phase 1); implementation begins in Phase 2
- **Related:** roadmap §3.3, §4.4.1–§4.4.7, D7; gates 2.1, 2.8, 2.9
- **Supersedes:** nothing
- **Superseded by:** nothing

## Context

Checkpoints must capture the file tree without changing the user's repository. Writing objects, refs, index files or config into the user's `.git` would:

- make ChronosCtx visible to the user's own tooling and to `git status`/`git gc`;
- race the user's git commands for the index lock;
- risk losing checkpoints when a user runs `git gc --prune=now`, deletes a branch, or re-clones;
- require modifying a repository we do not own.

At the same time, a fully separate store has a cost: it cannot share objects with the user's repository, so the first checkpoint re-hashes the tree. Phase 0 measured that cost and the conditions under which object-sharing (git alternates) is safe.

## Decision

1. **A dedicated shadow repository per project**, created with `init --bare` and then configured with `core.bare=false` and `core.worktree=<workspace>`. ChronosCtx owns its objects, refs and index. It never writes to the user's `.git`.
2. **Refs live under `refs/chronos/<branch>`.** The default branch name is not assumed to be `main`; it is read from project config. Nothing is pushed, and no hooks run (`hooks/` is emptied).
3. **The object store location is a per-project setting** (D7):
   - `home` (default): `CHRONOS_HOME/objects/<project_id>/`, with `shadow.git` and a persistent `shadow.index`;
   - `portable`: `<workspace>/.chronos/objects/`, for air-gapped or move-the-folder workflows.
   A project chooses once; switching is an explicit `chronos project relink`, not an implicit fallback.
4. **Alternates into the user's `.git/objects` only when both preconditions hold:** the user repo is sha1 **and** lives on the same filesystem. Otherwise the shadow store is self-contained and `checkpoints.alternates` records `0`. Eligibility is probed, not assumed.
5. **The persistent index is not the user's index.** `GIT_INDEX_FILE` points at the shadow index; corruption is detected by checksum and repaired by rebuild rather than by silently returning a wrong tree.
6. **A deterministic environment wraps every git invocation**: `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, identity, and the §4.4.2 config (`core.autocrlf=false`, `core.eol=lf`, `core.fileMode=false`, `core.precomposeUnicode`), with `safe.directory` set for the workspace. This is what makes content hashing cross-OS stable (Phase 0 K3).
7. **No-git fallback is supported.** When git is absent or unusable, checkpoints use `storage='manifest'` and a content-addressed blob store; they are marked as such, and file restore capability is reported honestly rather than assumed.

## Consequences

- The user's repository can be deleted, re-cloned or garbage-collected without losing ChronosCtx history.
- A shadow store duplicates objects when alternates are not eligible (sha256 repos, different volumes); that cost is visible in `chronos stats` and is the price of not touching the user's repo.
- `portable` makes `.chronos/objects` part of the folder the user copies; it is gitignored and its size is reported.
- The deterministic environment must be applied on every invocation, including read-only ones; a missing `GIT_CONFIG_GLOBAL` is a correctness bug, not a style issue.
- Network/synced drives are refused for both stores and for the workspace (`UNSAFE_FILESYSTEM`) rather than risking lock corruption.

## Alternatives considered

- **Use the user's `.git` with a private ref.** Rejected: still shares the object database, so a user `gc` can prune our unreachable objects, and our refs appear in their tooling.
- **Store checkpoints as tarballs/zip files in `CHRONOS_HOME`.** Rejected: no dedupe, no tree diff, no cheap restore of a changed-path subset; restore cost would dominate the Phase 0 measurement.
- **Always self-contained, never alternates.** Rejected as the only mode: for the common sha1-same-filesystem case it doubles disk and re-hashes on first checkpoint for no benefit. Alternates stay conditional and reversible.
- **Always portable.** Rejected as the default: it pollutes every workspace with a hidden store and breaks air-gapped use only if the store is elsewhere. `home` is the default; `portable` is opt-in.
- **Silently fall back to `home` when `portable` is not writable.** Rejected: a checkpoint that lives somewhere the user did not choose is worse than an explicit `UNSAFE_FILESYSTEM` refusal.
