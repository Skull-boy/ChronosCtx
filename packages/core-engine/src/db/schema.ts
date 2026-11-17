import {
  type AnySQLiteColumn,
  blob,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

/**
 * Drizzle mirror of the normative DDL (§4.2). Column names, types and
 * nullability must match `migrations/0001_init.sql`; `schema.parity.test.ts`
 * fails the build on drift.
 *
 * `nodes_fts` is an FTS5 virtual table and has no Drizzle representation; the
 * parity test names it explicitly rather than silently skipping it.
 */

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  ownerId: text("owner_id").notNull().default("local"),
  rootSummary: text("root_summary").notNull().default(""),
  activeObjective: text("active_objective"),
  defaultBranch: text("default_branch").notNull().default("main"),
  activeBranch: text("active_branch").notNull().default("main"),
  workspaceRoot: text("workspace_root"),
  objectStore: text("object_store", { enum: ["home", "portable"] })
    .notNull()
    .default("home"),
  indexMode: text("index_mode", { enum: ["auto", "flat", "grouped"] })
    .notNull()
    .default("auto"),
  budgetJson: text("budget_json")
    .notNull()
    .default('{"boot":150,"node":500,"page_in":800,"capsule":400,"tool_surface":900}'),
  verificationPolicyJson: text("verification_policy_json")
    .notNull()
    .default(
      '{"require_kind":["test_pass","build_pass","typecheck_pass","user_approval"],"allow_agent_override":false,"stale_on_any_diff":false}',
    ),
  retentionJson: text("retention_json")
    .notNull()
    .default('{"checkpoints_days":90,"captures_days":30,"paging_events_days":30}'),
  settingsJson: text("settings_json").notNull().default("{}"),
  schemaVersion: integer("schema_version").notNull().default(1),
  rev: integer("rev").notNull().default(1),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  deletedAt: integer("deleted_at"),
});

export const branches = sqliteTable(
  "branches",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    headCheckpointId: text("head_checkpoint_id").references(
      (): AnySQLiteColumn => checkpoints.checkpointId,
    ),
    forkedFromCheckpointId: text("forked_from_checkpoint_id").references(
      (): AnySQLiteColumn => checkpoints.checkpointId,
    ),
    baseBranch: text("base_branch"),
    status: text("status", { enum: ["active", "merged", "archived"] })
      .notNull()
      .default("active"),
    quiesceState: text("quiesce_state", { enum: ["open", "rewinding"] })
      .notNull()
      .default("open"),
    writeLeaseUntil: integer("write_lease_until"),
    worktreePath: text("worktree_path"),
    mergeCheckpointId: text("merge_checkpoint_id").references(
      (): AnySQLiteColumn => checkpoints.checkpointId,
    ),
    rev: integer("rev").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [unique("branches_project_name").on(table.projectId, table.name)],
);

export const verificationEvents = sqliteTable(
  "verification_events",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    checkpointId: text("checkpoint_id").references((): AnySQLiteColumn => checkpoints.checkpointId),
    nodePathsJson: text("node_paths_json").notNull().default("[]"),
    coveredPathsJson: text("covered_paths_json").notNull().default("[]"),
    treeHash: text("tree_hash"),
    snapshotHash: text("snapshot_hash"),
    kind: text("kind", {
      enum: [
        "test_pass",
        "build_pass",
        "typecheck_pass",
        "lint_pass",
        "user_approval",
        "import_trust",
        "override",
      ],
    }).notNull(),
    command: text("command"),
    exitCode: integer("exit_code"),
    durationMs: integer("duration_ms"),
    cwd: text("cwd"),
    logHash: text("log_hash"),
    logExcerpt: text("log_excerpt"),
    harness: text("harness"),
    verifiedBy: text("verified_by"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("idx_vev_project").on(table.projectId, table.createdAt)],
);

export const nodeVersions = sqliteTable(
  "node_versions",
  {
    versionId: text("version_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    nodePath: text("node_path").notNull(),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    status: text("status", { enum: ["unverified", "verified", "deprecated"] }).notNull(),
    sourceSurface: text("source_surface").notNull(),
    sourceRef: text("source_ref"),
    author: text("author"),
    createdOnBranch: text("created_on_branch").notNull(),
    verificationEventId: text("verification_event_id").references(() => verificationEvents.id),
    verifiedTreeHash: text("verified_tree_hash"),
    supersedesVersionId: text("supersedes_version_id").references(
      (): AnySQLiteColumn => nodeVersions.versionId,
    ),
    forkedFromVersionId: text("forked_from_version_id").references(
      (): AnySQLiteColumn => nodeVersions.versionId,
    ),
    tokensEstimate: integer("tokens_estimate").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    unique("node_versions_path_version").on(table.projectId, table.nodePath, table.version),
    index("idx_versions_hash").on(table.projectId, table.contentHash),
    index("idx_versions_path").on(table.projectId, table.nodePath, table.version),
  ],
);

export const stateNodes = sqliteTable(
  "state_nodes",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    branch: text("branch").notNull(),
    path: text("path").notNull(),
    headVersionId: text("head_version_id")
      .notNull()
      .references(() => nodeVersions.versionId),
    version: integer("version").notNull(),
    status: text("status", { enum: ["unverified", "verified", "deprecated"] }).notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    unique("state_nodes_head").on(table.projectId, table.branch, table.path),
    index("idx_state_nodes_lookup").on(table.projectId, table.branch, table.status),
    foreignKey({
      columns: [table.projectId, table.branch],
      foreignColumns: [branches.projectId, branches.name],
    }).onDelete("cascade"),
  ],
);

export const snapshots = sqliteTable(
  "snapshots",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    snapshotHash: text("snapshot_hash").notNull(),
    contentRoot: text("content_root").notNull(),
    kind: text("kind", { enum: ["state"] })
      .notNull()
      .default("state"),
    bodyZstd: blob("body_zstd", { mode: "buffer" }).notNull(),
    nodeCount: integer("node_count").notNull(),
    bytes: integer("bytes").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    unique("snapshots_identity").on(table.projectId, table.snapshotHash, table.kind),
    index("idx_snap_content").on(table.projectId, table.contentRoot),
  ],
);

export const checkpoints = sqliteTable(
  "checkpoints",
  {
    checkpointId: text("checkpoint_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    branchName: text("branch_name").notNull(),
    parentCheckpointId: text("parent_checkpoint_id").references(
      (): AnySQLiteColumn => checkpoints.checkpointId,
    ),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => snapshots.id),
    snapshotHash: text("snapshot_hash").notNull(),
    snapshotKind: text("snapshot_kind", { enum: ["combined", "state_only"] })
      .notNull()
      .default("combined"),
    storage: text("storage", { enum: ["git", "manifest", "none"] })
      .notNull()
      .default("git"),
    gitTreeHash: text("git_tree_hash"),
    gitCommitHash: text("git_commit_hash"),
    gitRef: text("git_ref"),
    alternates: integer("alternates").notNull().default(1),
    fileCount: integer("file_count").notNull().default(0),
    nodeCount: integer("node_count").notNull().default(0),
    message: text("message").notNull().default(""),
    kind: text("kind", {
      enum: [
        "manual",
        "auto_commit",
        "watch_green",
        "rewind_backup",
        "fork_point",
        "merge",
        "import",
      ],
    })
      .notNull()
      .default("manual"),
    isGreenBuild: integer("is_green_build").notNull().default(0),
    authorSurface: text("author_surface"),
    agentId: text("agent_id"),
    sessionId: text("session_id"),
    workspaceDrift: integer("workspace_drift").notNull().default(0),
    aborted: integer("aborted").notNull().default(0),
    abortedByRewindId: text("aborted_by_rewind_id"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_chk_branch").on(table.projectId, table.branchName, table.createdAt),
    index("idx_chk_parent").on(table.parentCheckpointId),
    index("idx_chk_snapshot").on(table.projectId, table.snapshotHash),
    index("idx_chk_tree").on(table.projectId, table.gitTreeHash),
  ],
);

export const negativeConstraints = sqliteTable(
  "negative_constraints",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    branch: text("branch"),
    nodePath: text("node_path"),
    failedApproach: text("failed_approach").notNull(),
    failureReason: text("failure_reason").notNull(),
    evidenceJson: text("evidence_json"),
    evidenceKind: text("evidence_kind", {
      enum: ["agent_reported", "test_failure", "build_failure", "user_reported", "incident"],
    })
      .notNull()
      .default("agent_reported"),
    severity: text("severity", { enum: ["blocking", "caution"] })
      .notNull()
      .default("caution"),
    promotedBy: text("promoted_by"),
    promotedAt: integer("promoted_at"),
    reviewAfter: integer("review_after"),
    dedupeKey: text("dedupe_key").notNull(),
    occurrences: integer("occurrences").notNull().default(1),
    fromAbortedCheckpointId: text("from_aborted_checkpoint_id").references(
      () => checkpoints.checkpointId,
    ),
    fromCheckpointId: text("from_checkpoint_id").references(() => checkpoints.checkpointId),
    sourceSurface: text("source_surface"),
    status: text("status", { enum: ["active", "superseded", "resolved"] })
      .notNull()
      .default("active"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    unique("negative_constraints_dedupe").on(table.projectId, table.dedupeKey),
    index("idx_nc_lookup").on(table.projectId, table.nodePath, table.status),
    index("idx_nc_branch").on(table.projectId, table.branch, table.status),
    index("idx_nc_sev").on(table.projectId, table.severity, table.status),
  ],
);

export const nodeAliases = sqliteTable(
  "node_aliases",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    branch: text("branch").notNull(),
    oldPath: text("old_path").notNull(),
    newPath: text("new_path").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.branch, table.oldPath] })],
);

export const rewinds = sqliteTable("rewinds", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  branch: text("branch").notNull(),
  fromCheckpointId: text("from_checkpoint_id")
    .notNull()
    .references(() => checkpoints.checkpointId),
  toCheckpointId: text("to_checkpoint_id")
    .notNull()
    .references(() => checkpoints.checkpointId),
  backupCheckpointId: text("backup_checkpoint_id").references(() => checkpoints.checkpointId),
  renderHash: text("render_hash").notNull(),
  failedApproach: text("failed_approach").notNull(),
  failureReason: text("failure_reason").notNull(),
  forced: integer("forced").notNull().default(0),
  driftFilesJson: text("drift_files_json").notNull().default("[]"),
  nodesRevertedJson: text("nodes_reverted_json").notNull().default("[]"),
  nodesDeletedJson: text("nodes_deleted_json").notNull().default("[]"),
  filesRestored: integer("files_restored").notNull().default(0),
  filesDeleted: integer("files_deleted").notNull().default(0),
  irreversibleJson: text("irreversible_json").notNull().default("[]"),
  negativeConstraintId: text("negative_constraint_id").references(() => negativeConstraints.id),
  durationMs: integer("duration_ms"),
  createdAt: integer("created_at").notNull(),
});

export const pagingEvents = sqliteTable(
  "paging_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id").notNull(),
    sessionId: text("session_id"),
    checkpointId: text("checkpoint_id"),
    surface: text("surface"),
    op: text("op", {
      enum: ["boot", "page_in", "page_out", "capsule", "rewind", "surface"],
    }).notNull(),
    pathsJson: text("paths_json").notNull().default("[]"),
    tokensContent: integer("tokens_content").notNull().default(0),
    tokensEnvelope: integer("tokens_envelope").notNull().default(0),
    tokensSchema: integer("tokens_schema").notNull().default(0),
    tokensServed: integer("tokens_served").notNull().default(0),
    tokensAvoided: integer("tokens_avoided").notNull().default(0),
    estimator: text("estimator").notNull().default("chars4"),
    latencyMs: integer("latency_ms"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("idx_paging_project").on(table.projectId, table.createdAt)],
);

export const nodeEdges = sqliteTable(
  "node_edges",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    fromPath: text("from_path").notNull(),
    toPath: text("to_path").notNull(),
    rel: text("rel", {
      enum: [
        "depends_on",
        "implements",
        "supersedes",
        "contradicts",
        "documents",
        "tests",
        "blocks",
        "related_to",
      ],
    }).notNull(),
    weight: real("weight").notNull().default(1.0),
    origin: text("origin", { enum: ["manual", "inferred", "import", "merge"] })
      .notNull()
      .default("manual"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    unique("node_edges_identity").on(table.projectId, table.fromPath, table.toPath, table.rel),
    index("idx_edges_from").on(table.projectId, table.fromPath, table.rel),
    index("idx_edges_to").on(table.projectId, table.toPath, table.rel),
  ],
);

export const agentSessions = sqliteTable(
  "agent_sessions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    branch: text("branch").notNull(),
    surface: text("surface").notNull(),
    agentId: text("agent_id"),
    clientPid: integer("client_pid"),
    startedAt: integer("started_at").notNull(),
    heartbeatAt: integer("heartbeat_at").notNull(),
    endedAt: integer("ended_at"),
    endReason: text("end_reason"),
  },
  (table) => [index("idx_sessions_live").on(table.projectId, table.branch, table.endedAt)],
);

export const sideEffects = sqliteTable(
  "side_effects",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    branch: text("branch").notNull(),
    checkpointId: text("checkpoint_id").references(() => checkpoints.checkpointId),
    kind: text("kind", {
      enum: [
        "package_install",
        "migration",
        "external_write",
        "remote_push",
        "email",
        "cloud_resource",
        "other",
      ],
    }).notNull(),
    description: text("description").notNull(),
    command: text("command"),
    reversible: integer("reversible").notNull().default(0),
    undoHint: text("undo_hint"),
    reportedBy: text("reported_by"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("idx_side_effects_window").on(table.projectId, table.branch, table.createdAt)],
);

export const captures = sqliteTable("captures", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  surface: text("surface").notNull(),
  sessionRef: text("session_ref"),
  rawHash: text("raw_hash").notNull(),
  payloadPath: text("payload_path").notNull(),
  redactionJson: text("redaction_json").notNull().default("{}"),
  distiller: text("distiller").notNull(),
  status: text("status", { enum: ["pending", "distilled", "rejected"] })
    .notNull()
    .default("pending"),
  createdAt: integer("created_at").notNull(),
});

export const proposals = sqliteTable("proposals", {
  id: text("id").primaryKey(),
  captureId: text("capture_id")
    .notNull()
    .references(() => captures.id, { onDelete: "cascade" }),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  nodePath: text("node_path").notNull(),
  op: text("op", { enum: ["create", "mutate", "deprecate", "constraint"] }).notNull(),
  contentJson: text("content_json").notNull(),
  confidence: real("confidence").notNull().default(0),
  diffJson: text("diff_json"),
  status: text("status", { enum: ["pending", "accepted", "rejected"] })
    .notNull()
    .default("pending"),
  createdAt: integer("created_at").notNull(),
});

export const syncOutbox = sqliteTable("sync_outbox", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  projectId: text("project_id").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id").notNull(),
  op: text("op").notNull(),
  payload: text("payload").notNull(),
  deviceId: text("device_id").notNull(),
  lamport: integer("lamport").notNull(),
  sentAt: integer("sent_at"),
  createdAt: integer("created_at").notNull(),
});

export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  platform: text("platform").notNull(),
  pubkey: text("pubkey"),
  lastSeen: integer("last_seen"),
  createdAt: integer("created_at").notNull(),
});

/** Every Drizzle table, keyed by SQL table name. `nodes_fts` is intentionally absent. */
export const TABLES = {
  projects,
  branches,
  node_versions: nodeVersions,
  state_nodes: stateNodes,
  snapshots,
  checkpoints,
  negative_constraints: negativeConstraints,
  verification_events: verificationEvents,
  node_aliases: nodeAliases,
  rewinds,
  paging_events: pagingEvents,
  node_edges: nodeEdges,
  agent_sessions: agentSessions,
  side_effects: sideEffects,
  captures,
  proposals,
  sync_outbox: syncOutbox,
  devices,
} as const;
