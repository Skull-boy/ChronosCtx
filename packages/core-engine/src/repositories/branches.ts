import { ChronosError } from "@chronos-ctx/shared-types";
import type { Row } from "@libsql/client";
import { integer, nullableInteger, nullableText, text } from "../db/rows.js";
import type { Sql } from "../db/sql.js";

export type BranchStatus = "active" | "merged" | "archived";
export type QuiesceState = "open" | "rewinding";

export interface Branch {
  id: string;
  projectId: string;
  name: string;
  headCheckpointId: string | null;
  forkedFromCheckpointId: string | null;
  baseBranch: string | null;
  status: BranchStatus;
  quiesceState: QuiesceState;
  writeLeaseUntil: number | null;
  worktreePath: string | null;
  mergeCheckpointId: string | null;
  rev: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateBranchInput {
  id: string;
  projectId: string;
  name: string;
  now: number;
  forkedFromCheckpointId?: string | null;
  baseBranch?: string | null;
  worktreePath?: string | null;
}

function toBranch(row: Row): Branch {
  return {
    id: text(row, "id"),
    projectId: text(row, "project_id"),
    name: text(row, "name"),
    headCheckpointId: nullableText(row, "head_checkpoint_id"),
    forkedFromCheckpointId: nullableText(row, "forked_from_checkpoint_id"),
    baseBranch: nullableText(row, "base_branch"),
    status: text(row, "status") as BranchStatus,
    quiesceState: text(row, "quiesce_state") as QuiesceState,
    writeLeaseUntil: nullableInteger(row, "write_lease_until"),
    worktreePath: nullableText(row, "worktree_path"),
    mergeCheckpointId: nullableText(row, "merge_checkpoint_id"),
    rev: integer(row, "rev"),
    createdAt: integer(row, "created_at"),
    updatedAt: integer(row, "updated_at"),
  };
}

const SELECT = `SELECT id, project_id, name, head_checkpoint_id, forked_from_checkpoint_id,
                       base_branch, status, quiesce_state, write_lease_until,
                       worktree_path, merge_checkpoint_id, rev, created_at, updated_at
                FROM branches`;

export async function createBranch(sql: Sql, input: CreateBranchInput): Promise<Branch> {
  await sql.execute({
    sql: `INSERT INTO branches
            (id, project_id, name, forked_from_checkpoint_id, base_branch,
             worktree_path, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      input.id,
      input.projectId,
      input.name,
      input.forkedFromCheckpointId ?? null,
      input.baseBranch ?? null,
      input.worktreePath ?? null,
      input.now,
      input.now,
    ],
  });
  const created = await getBranch(sql, input.projectId, input.name);
  if (created === null) {
    throw new ChronosError("INTERNAL", `branch ${input.name} was not readable after insert`);
  }
  return created;
}

export async function getBranch(sql: Sql, projectId: string, name: string): Promise<Branch | null> {
  const result = await sql.execute({
    sql: `${SELECT} WHERE project_id = ? AND name = ?`,
    args: [projectId, name],
  });
  const row = result.rows[0];
  return row === undefined ? null : toBranch(row);
}

export async function requireBranch(sql: Sql, projectId: string, name: string): Promise<Branch> {
  const branch = await getBranch(sql, projectId, name);
  if (branch === null) {
    throw new ChronosError("BRANCH_NOT_FOUND", `branch "${name}" does not exist`, {
      details: { project_id: projectId },
    });
  }
  return branch;
}

export async function listBranches(sql: Sql, projectId: string): Promise<Branch[]> {
  const result = await sql.execute({
    sql: `${SELECT} WHERE project_id = ? ORDER BY created_at ASC`,
    args: [projectId],
  });
  return result.rows.map(toBranch);
}

/** The single source of truth for branch head (ADR-0016). */
export async function setBranchHead(
  sql: Sql,
  projectId: string,
  name: string,
  checkpointId: string,
  now: number,
): Promise<void> {
  const result = await sql.execute({
    sql: `UPDATE branches
             SET head_checkpoint_id = ?, rev = rev + 1, updated_at = ?
           WHERE project_id = ? AND name = ?`,
    args: [checkpointId, now, projectId, name],
  });
  if (result.rowsAffected === 0) {
    throw new ChronosError("BRANCH_NOT_FOUND", `branch "${name}" does not exist`);
  }
}

export async function setQuiesceState(
  sql: Sql,
  projectId: string,
  name: string,
  state: QuiesceState,
  now: number,
): Promise<void> {
  await sql.execute({
    sql: `UPDATE branches SET quiesce_state = ?, updated_at = ? WHERE project_id = ? AND name = ?`,
    args: [state, now, projectId, name],
  });
}

/**
 * Rollback-safety guard: a write must be rejected while a rewind owns the
 * branch, and the check must happen inside the writer's transaction.
 */
export async function assertWritable(sql: Sql, projectId: string, name: string): Promise<Branch> {
  const branch = await requireBranch(sql, projectId, name);
  if (branch.quiesceState === "rewinding") {
    throw new ChronosError(
      "WRITE_REJECTED_BRANCH_QUIESCED",
      `branch "${name}" is rewinding; retry after the rewind completes`,
      { retriable: true, retryAfterMs: 1000 },
    );
  }
  if (branch.status !== "active") {
    throw new ChronosError(
      "WRITE_REJECTED_BRANCH_QUIESCED",
      `branch "${name}" is ${branch.status}; open or fork a branch before writing`,
    );
  }
  return branch;
}
