-- 0001_init.sql — the Phase 1 schema, normative per roadmap §4.2.
--
-- Forward-only. `PRAGMA user_version` records the applied level.
-- Connection pragmas are applied by db/client.ts on every connection:
--   journal_mode=WAL, synchronous=NORMAL, foreign_keys=ON, busy_timeout=5000
--
-- Do not edit an applied migration. Add 000N_*.sql instead.

-- ── projects ─────────────────────────────────────────────────────────────
CREATE TABLE projects (
  id                 TEXT PRIMARY KEY,                -- prj_<ulid>
  slug               TEXT NOT NULL UNIQUE,            -- kebab-case, stable
  name               TEXT NOT NULL,
  owner_id           TEXT NOT NULL DEFAULT 'local',   -- single-user today; additive for teams (v2)
  root_summary       TEXT NOT NULL DEFAULT '',        -- ≤ 60 tokens, index header
  active_objective   TEXT,                            -- ≤ 30 tokens, shown at boot
  default_branch     TEXT NOT NULL DEFAULT 'main',
  active_branch      TEXT NOT NULL DEFAULT 'main',    -- UI preference ONLY; not a source of truth
  workspace_root     TEXT,                            -- absolute, LOCAL-ONLY, never synced
  object_store       TEXT NOT NULL DEFAULT 'home'
                     CHECK (object_store IN ('home','portable')),   -- see §3.3
  index_mode         TEXT NOT NULL DEFAULT 'auto'
                     CHECK (index_mode IN ('auto','flat','grouped')),
  budget_json        TEXT NOT NULL
                     DEFAULT '{"boot":150,"node":500,"page_in":800,"capsule":400,"tool_surface":900}',
  verification_policy_json TEXT NOT NULL
                     DEFAULT '{"require_kind":["test_pass","build_pass","typecheck_pass","user_approval"],
                               "allow_agent_override":false,"stale_on_any_diff":false}',
  retention_json     TEXT NOT NULL
                     DEFAULT '{"checkpoints_days":90,"captures_days":30,"paging_events_days":30}',
  settings_json      TEXT NOT NULL DEFAULT '{}',
  schema_version     INTEGER NOT NULL DEFAULT 1,
  rev                INTEGER NOT NULL DEFAULT 1,       -- optimistic concurrency for sync
  created_at         INTEGER NOT NULL,                 -- epoch ms UTC
  updated_at         INTEGER NOT NULL,
  deleted_at         INTEGER
) STRICT;

-- NOTE: there is deliberately NO projects.head_checkpoint_id. Branch head lives
-- only in branches.head_checkpoint_id (I10); any "project head" is a derived read
-- over the active branch and is never stored twice.

-- ── branches (fork/merge bookkeeping; checkpoints still carry branch_name) ─
CREATE TABLE branches (
  id                       TEXT PRIMARY KEY,           -- brn_<ulid>
  project_id               TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name                     TEXT NOT NULL,
  head_checkpoint_id       TEXT REFERENCES checkpoints(checkpoint_id),  -- SINGLE source of truth
  forked_from_checkpoint_id TEXT REFERENCES checkpoints(checkpoint_id),
  base_branch              TEXT,
  status                   TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','merged','archived')),
  quiesce_state            TEXT NOT NULL DEFAULT 'open'
                           CHECK (quiesce_state IN ('open','rewinding')),
  write_lease_until        INTEGER,                    -- epoch ms; NULL = free (see §2.11)
  worktree_path            TEXT,
  merge_checkpoint_id      TEXT REFERENCES checkpoints(checkpoint_id),
  rev                      INTEGER NOT NULL DEFAULT 1, -- optimistic concurrency for sync
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  UNIQUE (project_id, name)
) STRICT;

-- ── immutable node revision ledger ──────────────────────────────────────
CREATE TABLE node_versions (
  version_id             TEXT PRIMARY KEY,             -- ver_<ulid>
  project_id             TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  node_path              TEXT NOT NULL,
  version                INTEGER NOT NULL,             -- PROJECT-GLOBAL per (project_id, node_path), D1
  title                  TEXT NOT NULL,
  summary                TEXT NOT NULL,                -- ≤ 25 tokens, index line
  content                TEXT NOT NULL,                -- markdown/JSON, ≤ 800 tok target
  content_hash           TEXT NOT NULL,                -- sha256("chronos-content-v1\n" + title + "\n" + summary + "\n" + content)
  status                 TEXT NOT NULL
                         CHECK (status IN ('unverified','verified','deprecated')),
  source_surface         TEXT NOT NULL,                -- opencode-cli | antigravity | claude-code |
                                                       -- cline | cursor | pi | gemini-web |
                                                       -- chatgpt-web | claude-web | qwen-web | import
  source_ref             TEXT,                         -- transcript turn / tool call / url hash
  author                 TEXT,                         -- "agent:opencode" | "user:alice"
  created_on_branch      TEXT NOT NULL,                -- provenance, not visibility
  verification_event_id  TEXT REFERENCES verification_events(id),
  verified_tree_hash     TEXT,                         -- denormalized from the event for cheap freshness
  supersedes_version_id  TEXT REFERENCES node_versions(version_id),
  forked_from_version_id TEXT REFERENCES node_versions(version_id),
  tokens_estimate        INTEGER NOT NULL DEFAULT 0,
  created_at             INTEGER NOT NULL,
  UNIQUE (project_id, node_path, version)
) STRICT;

CREATE INDEX idx_versions_hash ON node_versions(project_id, content_hash);
CREATE INDEX idx_versions_path ON node_versions(project_id, node_path, version DESC);

-- ── head pointers (one row per node per branch) ─────────────────────────
CREATE TABLE state_nodes (
  id              TEXT PRIMARY KEY,                    -- nod_<ulid>
  project_id      TEXT NOT NULL,
  branch          TEXT NOT NULL,
  path            TEXT NOT NULL,
  head_version_id TEXT NOT NULL REFERENCES node_versions(version_id),
  version         INTEGER NOT NULL,                    -- denormalized for cheap filters
  status          TEXT NOT NULL
                  CHECK (status IN ('unverified','verified','deprecated')),
  updated_at      INTEGER NOT NULL,
  UNIQUE (project_id, branch, path),
  FOREIGN KEY (project_id, branch) REFERENCES branches(project_id, name) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_state_nodes_lookup ON state_nodes(project_id, branch, status);

-- Spec-facing view: exposes the fields the brief assigns to `state_nodes`
-- without denormalizing content into two places.
CREATE VIEW state_nodes_full AS
SELECT n.id, n.project_id, n.branch, n.path,
       v.version_id, v.title, v.summary, v.content, v.status, v.version,
       v.source_surface, v.source_ref, v.author, v.content_hash,
       v.tokens_estimate, v.created_at, n.updated_at
FROM state_nodes n
JOIN node_versions v ON v.version_id = n.head_version_id;

-- ── snapshots: content-addressed, immutable, deduped (I11) ───────────────
CREATE TABLE snapshots (
  id             TEXT PRIMARY KEY,                     -- snp_<ulid>
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_hash  TEXT NOT NULL,                        -- "sha256:<hex>", hash over (path, version_id) — exact local identity (§4.2.1)
  content_root   TEXT NOT NULL,                        -- "sha256:<hex>", hash over (path, content_hash) — portable identity for sync
  kind           TEXT NOT NULL DEFAULT 'state'
                 CHECK (kind IN ('state')),              -- only reasoning-state maps exist; trees live in git/manifest
  body_zstd      BLOB NOT NULL,                        -- canonical sorted "path\0version_id" lines, zstd
  node_count     INTEGER NOT NULL,
  bytes          INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  UNIQUE (project_id, snapshot_hash, kind)             -- one row per distinct state, ever
) STRICT;

CREATE INDEX idx_snap_content ON snapshots(project_id, content_root);

-- ── checkpoints: the time-travel DAG ────────────────────────────────────
CREATE TABLE checkpoints (
  checkpoint_id         TEXT PRIMARY KEY,              -- chk_<ulid>
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  branch_name           TEXT NOT NULL,
  parent_checkpoint_id  TEXT REFERENCES checkpoints(checkpoint_id),
  snapshot_id           TEXT NOT NULL REFERENCES snapshots(id),   -- state snapshot (deduped)
  snapshot_hash         TEXT NOT NULL,                 -- denormalized for indexes/freshness
  snapshot_kind         TEXT NOT NULL DEFAULT 'combined'
                        CHECK (snapshot_kind IN ('combined','state_only')),
  storage               TEXT NOT NULL DEFAULT 'git'
                        CHECK (storage IN ('git','manifest','none')),  -- how files were captured
  git_tree_hash         TEXT,                          -- null for web-only checkpoints
  git_commit_hash       TEXT,
  git_ref               TEXT,                          -- refs/chronos/<branch>
  alternates            INTEGER NOT NULL DEFAULT 1 CHECK (alternates IN (0,1)),
  file_count            INTEGER NOT NULL DEFAULT 0,
  node_count            INTEGER NOT NULL DEFAULT 0,
  message               TEXT NOT NULL DEFAULT '',
  kind                  TEXT NOT NULL DEFAULT 'manual'
                        CHECK (kind IN ('manual','auto_commit','watch_green',
                                        'rewind_backup','fork_point','merge','import')),
  is_green_build        INTEGER NOT NULL DEFAULT 0 CHECK (is_green_build IN (0,1)),
  author_surface        TEXT,
  agent_id              TEXT,
  session_id            TEXT,
  workspace_drift       INTEGER NOT NULL DEFAULT 0 CHECK (workspace_drift IN (0,1)),
  aborted               INTEGER NOT NULL DEFAULT 0 CHECK (aborted IN (0,1)),
  aborted_by_rewind_id  TEXT,
  created_at            INTEGER NOT NULL,
  -- I5: a combined checkpoint must have a captured tree (git) or a manifest store;
  -- a state_only checkpoint has no files at all. No third possibility exists.
  CHECK (
    (snapshot_kind = 'state_only' AND storage = 'none' AND git_tree_hash IS NULL)
    OR
    (snapshot_kind = 'combined' AND (
       (storage = 'git'      AND git_tree_hash IS NOT NULL)
       OR (storage = 'manifest' AND git_tree_hash IS NULL)
    ))
  )
) STRICT;

CREATE INDEX idx_chk_branch   ON checkpoints(project_id, branch_name, created_at DESC);
CREATE INDEX idx_chk_parent   ON checkpoints(parent_checkpoint_id);
CREATE INDEX idx_chk_snapshot ON checkpoints(project_id, snapshot_hash);
CREATE INDEX idx_chk_tree     ON checkpoints(project_id, git_tree_hash);

-- ── negative constraints: hallucination blockers with provenance ─────────
CREATE TABLE negative_constraints (
  id                         TEXT PRIMARY KEY,         -- nc_<ulid>
  project_id                 TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  branch                     TEXT,                     -- NULL = project-global
  node_path                  TEXT,                     -- NULL = branch-global
  failed_approach            TEXT NOT NULL,            -- imperative: "Do not use jose@4 on Edge"
  failure_reason             TEXT NOT NULL,            -- observed evidence
  evidence_json              TEXT,                     -- {command, exitCode, logHash, urls}
  evidence_kind              TEXT NOT NULL DEFAULT 'agent_reported'
                             CHECK (evidence_kind IN ('agent_reported','test_failure',
                                                      'build_failure','user_reported','incident')),
  severity                   TEXT NOT NULL DEFAULT 'caution'
                             CHECK (severity IN ('blocking','caution')),  -- C8: caution by default
  promoted_by                TEXT,                     -- "user:alice" | "ci:github"; NULL until promoted
  promoted_at                INTEGER,
  review_after               INTEGER,                  -- epoch ms; NULL = no expiry
  dedupe_key                 TEXT NOT NULL,            -- sha256(branch|node_path|normalized approach)
  occurrences                INTEGER NOT NULL DEFAULT 1,
  from_aborted_checkpoint_id TEXT REFERENCES checkpoints(checkpoint_id),
  from_checkpoint_id         TEXT REFERENCES checkpoints(checkpoint_id),
  source_surface             TEXT,
  status                     TEXT NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active','superseded','resolved')),
  created_at                 INTEGER NOT NULL,
  updated_at                 INTEGER NOT NULL,
  UNIQUE (project_id, dedupe_key)
) STRICT;

CREATE INDEX idx_nc_lookup  ON negative_constraints(project_id, node_path, status);
CREATE INDEX idx_nc_branch  ON negative_constraints(project_id, branch, status);
CREATE INDEX idx_nc_sev     ON negative_constraints(project_id, severity, status);

-- Dedupe is branch-inclusive: the same failed approach on two branches is two
-- rows (two independent observations), never one row silently shared. A NULL
-- branch folds to the literal '*' in dedupe_key so project-global rows dedupe
-- with each other only.

-- ── verification evidence (the only path to `verified`) ─────────────────
CREATE TABLE verification_events (
  id               TEXT PRIMARY KEY,                   -- vev_<ulid>
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  checkpoint_id    TEXT REFERENCES checkpoints(checkpoint_id),
  node_paths_json  TEXT NOT NULL DEFAULT '[]',
  covered_paths_json TEXT NOT NULL DEFAULT '[]',       -- files/dirs the command actually exercised
  tree_hash        TEXT,                               -- tree this evidence was produced against
  snapshot_hash    TEXT,                               -- state snapshot at verification time
  kind             TEXT NOT NULL CHECK (kind IN ('test_pass','build_pass','typecheck_pass',
                                                 'lint_pass','user_approval','import_trust','override')),
  command          TEXT,
  exit_code        INTEGER,
  duration_ms      INTEGER,
  cwd              TEXT,
  log_hash         TEXT,                               -- sha256 of redacted log
  log_excerpt      TEXT,                               -- ≤ 2 KB, redacted
  harness          TEXT,                               -- vitest|jest|pytest|go|cargo|custom…
  verified_by      TEXT,                               -- "ci:github" | "user:alice" | "agent:opencode"
  created_at       INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_vev_project ON verification_events(project_id, created_at DESC);
CREATE INDEX idx_vev_tree    ON verification_events(project_id, tree_hash);

-- Tree-bound freshness is computed, never stored as truth:
--   fresh   ⇔ diff(current_tree, vev.tree_hash) ∩ covered_paths = ∅
--   stale   ⇔ that diff touches ≥ 1 covered path
--   unknown ⇔ vev.tree_hash IS NULL (no workspace) OR covered_paths is empty
-- Whole-tree equality is sufficient but not required: an unrelated edit must not
-- invalidate every verified node in the project.
-- The computed value is cached per (node, response) for the lifetime of a single
-- request only, so a stale value can never outlive the tree it described.

-- ── node aliases (stable URIs across renames) ───────────────────────────
CREATE TABLE node_aliases (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  branch     TEXT NOT NULL,
  old_path   TEXT NOT NULL,
  new_path   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, branch, old_path)
) STRICT;

-- ── rewind audit (never lost, even though history is "undone") ──────────
CREATE TABLE rewinds (
  id                     TEXT PRIMARY KEY,             -- rwd_<ulid>
  project_id             TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  branch                 TEXT NOT NULL,
  from_checkpoint_id     TEXT NOT NULL REFERENCES checkpoints(checkpoint_id),
  to_checkpoint_id       TEXT NOT NULL REFERENCES checkpoints(checkpoint_id),
  backup_checkpoint_id   TEXT REFERENCES checkpoints(checkpoint_id),
  render_hash            TEXT NOT NULL,                -- sha256 of the rendered capsule text (reproducible; §4.6)
  failed_approach        TEXT NOT NULL,
  failure_reason         TEXT NOT NULL,
  forced                 INTEGER NOT NULL DEFAULT 0 CHECK (forced IN (0,1)),
  drift_files_json       TEXT NOT NULL DEFAULT '[]',
  nodes_reverted_json    TEXT NOT NULL DEFAULT '[]',
  nodes_deleted_json     TEXT NOT NULL DEFAULT '[]',
  files_restored         INTEGER NOT NULL DEFAULT 0,
  files_deleted          INTEGER NOT NULL DEFAULT 0,
  irreversible_json      TEXT NOT NULL DEFAULT '[]',   -- side_effects ids caught in the rolled-back range
  negative_constraint_id TEXT REFERENCES negative_constraints(id),
  duration_ms            INTEGER,
  created_at             INTEGER NOT NULL
) STRICT;

-- ── token accounting (feeds benchmarks; net, envelope-inclusive) ────────
CREATE TABLE paging_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id        TEXT NOT NULL,
  session_id        TEXT,
  checkpoint_id     TEXT,
  surface           TEXT,
  op                TEXT NOT NULL CHECK (op IN ('boot','page_in','page_out','capsule','rewind','surface')),
  paths_json        TEXT NOT NULL DEFAULT '[]',
  tokens_content    INTEGER NOT NULL DEFAULT 0,
  tokens_envelope   INTEGER NOT NULL DEFAULT 0,
  tokens_schema     INTEGER NOT NULL DEFAULT 0,        -- tool-surface share attributed to this call
  tokens_served     INTEGER NOT NULL DEFAULT 0,        -- content + envelope + schema
  tokens_avoided    INTEGER NOT NULL DEFAULT 0,        -- vs. naive transcript replay
  estimator         TEXT NOT NULL DEFAULT 'chars4',
  latency_ms        INTEGER,
  created_at        INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_paging_project ON paging_events(project_id, created_at DESC);

-- ── typed edges: the state graph is actually a graph (C3) ───────────────
CREATE TABLE node_edges (
  id            TEXT PRIMARY KEY,                      -- edg_<ulid>
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_path     TEXT NOT NULL,
  to_path       TEXT NOT NULL,
  rel           TEXT NOT NULL
                CHECK (rel IN ('depends_on','implements','supersedes','contradicts',
                               'documents','tests','blocks','related_to')),
  weight        REAL NOT NULL DEFAULT 1.0,
  origin        TEXT NOT NULL DEFAULT 'manual'
                CHECK (origin IN ('manual','inferred','import','merge')),
  created_at    INTEGER NOT NULL,
  UNIQUE (project_id, from_path, to_path, rel)
) STRICT;

CREATE INDEX idx_edges_from ON node_edges(project_id, from_path, rel);
CREATE INDEX idx_edges_to   ON node_edges(project_id, to_path, rel);

-- ── agent sessions: who is writing, from where, right now (C12) ─────────
CREATE TABLE agent_sessions (
  id             TEXT PRIMARY KEY,                     -- ses_<ulid>
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  branch         TEXT NOT NULL,
  surface        TEXT NOT NULL,                        -- mcp-stdio | mcp-http | extension | cli
  agent_id       TEXT,                                 -- "opencode" | "claude-code" | "user"
  client_pid     INTEGER,
  started_at     INTEGER NOT NULL,
  heartbeat_at   INTEGER NOT NULL,
  ended_at       INTEGER,
  end_reason     TEXT                                  -- clean | crashed | superseded | rewind
) STRICT;

CREATE INDEX idx_sessions_live ON agent_sessions(project_id, branch, ended_at);

-- ── irreversible side effects: the honest boundary of "time travel" ─────
CREATE TABLE side_effects (
  id             TEXT PRIMARY KEY,                     -- sfe_<ulid>
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  branch         TEXT NOT NULL,
  checkpoint_id  TEXT REFERENCES checkpoints(checkpoint_id),
  kind           TEXT NOT NULL
                 CHECK (kind IN ('package_install','migration','external_write',
                                 'remote_push','email','cloud_resource','other')),
  description    TEXT NOT NULL,
  command        TEXT,
  reversible     INTEGER NOT NULL DEFAULT 0 CHECK (reversible IN (0,1)),
  undo_hint      TEXT,
  reported_by    TEXT,
  created_at     INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_side_effects_window ON side_effects(project_id, branch, created_at DESC);

-- ── full-text index over node heads (optional ranking, never truth) ─────
CREATE VIRTUAL TABLE nodes_fts USING fts5(
  project_id UNINDEXED,
  branch     UNINDEXED,
  path,
  title,
  summary,
  content,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- ── Phase 4: captures, proposals, sync outbox ───────────────────────────
CREATE TABLE captures (
  id              TEXT PRIMARY KEY,                     -- cap_<ulid>
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  surface         TEXT NOT NULL,
  session_ref     TEXT,
  raw_hash        TEXT NOT NULL,
  payload_path    TEXT NOT NULL,                        -- .chronos/captures/<id>.jsonl
  redaction_json  TEXT NOT NULL DEFAULT '{}',
  distiller       TEXT NOT NULL,                        -- deterministic@1 | llm@1
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','distilled','rejected')),
  created_at      INTEGER NOT NULL
) STRICT;

CREATE TABLE proposals (
  id           TEXT PRIMARY KEY,                        -- prp_<ulid>
  capture_id   TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  node_path    TEXT NOT NULL,
  op           TEXT NOT NULL CHECK (op IN ('create','mutate','deprecate','constraint')),
  content_json TEXT NOT NULL,
  confidence   REAL NOT NULL DEFAULT 0,
  diff_json    TEXT,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','accepted','rejected')),
  created_at   INTEGER NOT NULL
) STRICT;

CREATE TABLE sync_outbox (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  op         TEXT NOT NULL,
  payload    TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  lamport    INTEGER NOT NULL,
  sent_at    INTEGER,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE devices (
  id         TEXT PRIMARY KEY,                          -- dev_<ulid>
  name       TEXT NOT NULL,
  platform   TEXT NOT NULL,
  pubkey     TEXT,
  last_seen  INTEGER,
  created_at INTEGER NOT NULL
) STRICT;
