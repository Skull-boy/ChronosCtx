import { ChronosError } from "@chronos-ctx/shared-types";
import type { Row } from "@libsql/client";
import { integer, nullableText, text } from "../db/rows.js";
import type { Sql } from "../db/sql.js";

export type SnapshotKind = "combined" | "state_only";
export type CheckpointStorage = "git" | "manifest" | "none";
export type CheckpointKind =
  | "manual"
  | "auto_commit"
  | "watch_green"
  | "rewind_backup"
  | "fork_point"
  | "merge"
  | "import";

export interface Checkpoint {
  checkpointId: string;
  projectId: string;
  branchName: string;
  parentCheckpointId: string | null;
  snapshotId: string;
  snapshotHash: string;
  snapshotKind: SnapshotKind;
  storage: CheckpointStorage;
  gitTreeHash: string | null;
  gitCommitHash: string | null;
  gitRef: string | null;
  alternates: number;
  fileCount: number;
  nodeCount: number;
  message: string;
  kind: CheckpointKind;
  isGreenBuild: boolean;
  authorSurface: string | null;
  agentId: string | null;
  sessionId: string | null;
  workspaceDrift: boolean;
  aborted: boolean;
  abortedByRewindId: string | null;
  createdAt: number;
}

export interface CreateCheckpointInput
  extends Omit<Checkpoint, "isGreenBuild" | "workspaceDrift" | "aborted" | "abortedByRewindId"> {
  isGreenBuild?: boolean;
  workspaceDrift?: boolean;
  aborted?: boolean;
  abortedByRewindId?: string | null;
}

/**
 * D6/I5: a combined checkpoint must name a captured tree, a state-only
 * checkpoint must name none. Checking here produces a useful error before the
 * database CHECK fires with a generic constraint message.
 */
function assertShape(input: CreateCheckpointInput): void {
  if (input.snapshotKind === "state_only") {
    if (input.storage !== "none" || input.gitTreeHash !== null) {
      throw new ChronosError(
        "UNSUPPORTED",
        "state_only checkpoint must use storage='none' and no git tree",
      );
    }
    return;
  }
  if (input.storage === "git" && input.gitTreeHash === null) {
    throw new ChronosError("UNSUPPORTED", "git checkpoint requires a git_tree_hash");
  }
  if (input.storage === "manifest" && input.gitTreeHash !== null) {
    throw new ChronosError("UNSUPPORTED", "manifest checkpoint must not carry a git_tree_hash");
  }
  if (input.storage === "none") {
    throw new ChronosError("UNSUPPORTED", "combined checkpoint requires storage git or manifest");
  }
}

export async function insertCheckpoint(
  sql: Sql,
  input: CreateCheckpointInput,
): Promise<Checkpoint> {
  assertShape(input);
  await sql.execute({
    sql: `INSERT INTO checkpoints
            (checkpoint_id, project_id, branch_name, parent_checkpoint_id,
             snapshot_id, snapshot_hash, snapshot_kind, storage,
             git_tree_hash, git_commit_hash, git_ref, alternates,
             file_count, node_count, message, kind, is_green_build,
             author_surface, agent_id, session_id, workspace_drift, aborted,
             aborted_by_rewind_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      input.checkpointId,
      input.projectId,
      input.branchName,
      input.parentCheckpointId,
      input.snapshotId,
      input.snapshotHash,
      input.snapshotKind,
      input.storage,
      input.gitTreeHash,
      input.gitCommitHash,
      input.gitRef,
      input.alternates,
      input.fileCount,
      input.nodeCount,
      input.message,
      input.kind,
      input.isGreenBuild === true ? 1 : 0,
      input.authorSurface,
      input.agentId,
      input.sessionId,
      input.workspaceDrift === true ? 1 : 0,
      input.aborted === true ? 1 : 0,
      input.abortedByRewindId ?? null,
      input.createdAt,
    ],
  });
  const created = await getCheckpoint(sql, input.checkpointId);
  if (created === null) {
    throw new ChronosError("INTERNAL", "checkpoint row missing after insert");
  }
  return created;
}

function toCheckpoint(row: Row): Checkpoint {
  return {
    checkpointId: text(row, "checkpoint_id"),
    projectId: text(row, "project_id"),
    branchName: text(row, "branch_name"),
    parentCheckpointId: nullableText(row, "parent_checkpoint_id"),
    snapshotId: text(row, "snapshot_id"),
    snapshotHash: text(row, "snapshot_hash"),
    snapshotKind: text(row, "snapshot_kind") as SnapshotKind,
    storage: text(row, "storage") as CheckpointStorage,
    gitTreeHash: nullableText(row, "git_tree_hash"),
    gitCommitHash: nullableText(row, "git_commit_hash"),
    gitRef: nullableText(row, "git_ref"),
    alternates: integer(row, "alternates"),
    fileCount: integer(row, "file_count"),
    nodeCount: integer(row, "node_count"),
    message: text(row, "message"),
    kind: text(row, "kind") as CheckpointKind,
    isGreenBuild: integer(row, "is_green_build") === 1,
    authorSurface: nullableText(row, "author_surface"),
    agentId: nullableText(row, "agent_id"),
    sessionId: nullableText(row, "session_id"),
    workspaceDrift: integer(row, "workspace_drift") === 1,
    aborted: integer(row, "aborted") === 1,
    abortedByRewindId: nullableText(row, "aborted_by_rewind_id"),
    createdAt: integer(row, "created_at"),
  };
}

const SELECT = `SELECT checkpoint_id, project_id, branch_name, parent_checkpoint_id,
                       snapshot_id, snapshot_hash, snapshot_kind, storage,
                       git_tree_hash, git_commit_hash, git_ref, alternates,
                       file_count, node_count, message, kind, is_green_build,
                       author_surface, agent_id, session_id, workspace_drift,
                       aborted, aborted_by_rewind_id, created_at
                FROM checkpoints`;

export async function getCheckpoint(sql: Sql, id: string): Promise<Checkpoint | null> {
  const result = await sql.execute({ sql: `${SELECT} WHERE checkpoint_id = ?`, args: [id] });
  const row = result.rows[0];
  return row === undefined ? null : toCheckpoint(row);
}

export async function requireCheckpoint(sql: Sql, id: string): Promise<Checkpoint> {
  const checkpoint = await getCheckpoint(sql, id);
  if (checkpoint === null) {
    throw new ChronosError("CHECKPOINT_NOT_FOUND", `checkpoint ${id} does not exist`);
  }
  return checkpoint;
}

export async function listCheckpoints(
  sql: Sql,
  projectId: string,
  branch: string,
  limit = 50,
): Promise<Checkpoint[]> {
  const result = await sql.execute({
    sql: `${SELECT} WHERE project_id = ? AND branch_name = ?
          ORDER BY created_at DESC, checkpoint_id DESC LIMIT ?`,
    args: [projectId, branch, limit],
  });
  return result.rows.map(toCheckpoint);
}

export async function countCheckpoints(sql: Sql, projectId: string): Promise<number> {
  const result = await sql.execute({
    sql: "SELECT count(*) AS n FROM checkpoints WHERE project_id = ?",
    args: [projectId],
  });
  const row = result.rows[0];
  return row === undefined ? 0 : integer(row, "n");
}

export async function getBranchHead(
  sql: Sql,
  projectId: string,
  branch: string,
): Promise<Checkpoint | null> {
  const result = await sql.execute({
    sql: `SELECT c.checkpoint_id, c.project_id, c.branch_name, c.parent_checkpoint_id,
                 c.snapshot_id, c.snapshot_hash, c.snapshot_kind, c.storage,
                 c.git_tree_hash, c.git_commit_hash, c.git_ref, c.alternates,
                 c.file_count, c.node_count, c.message, c.kind, c.is_green_build,
                 c.author_surface, c.agent_id, c.session_id, c.workspace_drift,
                 c.aborted, c.aborted_by_rewind_id, c.created_at
            FROM branches b
            JOIN checkpoints c ON c.checkpoint_id = b.head_checkpoint_id
           WHERE b.project_id = ? AND b.name = ?`,
    args: [projectId, branch],
  });
  const row = result.rows[0];
  return row === undefined ? null : toCheckpoint(row);
}
