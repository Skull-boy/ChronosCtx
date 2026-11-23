import type { Row } from "@libsql/client";
import { integer, nullableInteger, nullableText, text } from "../db/rows.js";
import type { Sql } from "../db/sql.js";

export type ConstraintSeverity = "blocking" | "caution";
export type ConstraintEvidenceKind =
  | "agent_reported"
  | "test_failure"
  | "build_failure"
  | "user_reported"
  | "incident";
export type ConstraintStatus = "active" | "superseded" | "resolved";

export interface NegativeConstraint {
  id: string;
  projectId: string;
  branch: string | null;
  nodePath: string | null;
  failedApproach: string;
  failureReason: string;
  evidenceKind: ConstraintEvidenceKind;
  severity: ConstraintSeverity;
  occurrences: number;
  promotedBy: string | null;
  promotedAt: number | null;
  reviewAfter: number | null;
  status: ConstraintStatus;
  createdAt: number;
  updatedAt: number;
}

export interface ConstraintStats {
  active: number;
  blocking: number;
}

function toConstraint(row: Row): NegativeConstraint {
  return {
    id: text(row, "id"),
    projectId: text(row, "project_id"),
    branch: nullableText(row, "branch"),
    nodePath: nullableText(row, "node_path"),
    failedApproach: text(row, "failed_approach"),
    failureReason: text(row, "failure_reason"),
    evidenceKind: text(row, "evidence_kind") as ConstraintEvidenceKind,
    severity: text(row, "severity") as ConstraintSeverity,
    occurrences: integer(row, "occurrences"),
    promotedBy: nullableText(row, "promoted_by"),
    promotedAt: nullableInteger(row, "promoted_at"),
    reviewAfter: nullableInteger(row, "review_after"),
    status: text(row, "status") as ConstraintStatus,
    createdAt: integer(row, "created_at"),
    updatedAt: integer(row, "updated_at"),
  };
}

const SELECT = `SELECT id, project_id, branch, node_path, failed_approach, failure_reason,
                       evidence_kind, severity, occurrences, promoted_by, promoted_at,
                       review_after, status, created_at, updated_at
                FROM negative_constraints`;

/**
 * Constraints that apply to a path: node-scoped (including ancestors), branch
 * scoped, and project scoped. Blocking sorts first, then the most frequently
 * observed, then the newest.
 */
export async function listConstraintsForPath(
  sql: Sql,
  projectId: string,
  branch: string,
  path: string,
  limit = 10,
): Promise<NegativeConstraint[]> {
  const result = await sql.execute({
    sql: `${SELECT}
           WHERE project_id = ? AND status = 'active'
             AND (branch IS NULL OR branch = ?)
             AND (node_path IS NULL OR node_path = ? OR ? LIKE node_path || '/%')
           ORDER BY CASE severity WHEN 'blocking' THEN 0 ELSE 1 END,
                    occurrences DESC, created_at DESC
           LIMIT ?`,
    args: [projectId, branch, path, path, limit],
  });
  return result.rows.map(toConstraint);
}

export async function constraintStats(
  sql: Sql,
  projectId: string,
  branch: string,
): Promise<ConstraintStats> {
  const result = await sql.execute({
    sql: `SELECT count(*) AS active,
                 coalesce(sum(CASE WHEN severity = 'blocking' THEN 1 ELSE 0 END), 0) AS blocking
            FROM negative_constraints
           WHERE project_id = ? AND status = 'active'
             AND (branch IS NULL OR branch = ?)`,
    args: [projectId, branch],
  });
  const row = result.rows[0];
  if (row === undefined) return { active: 0, blocking: 0 };
  return { active: integer(row, "active"), blocking: integer(row, "blocking") };
}

/**
 * Branch-applicable active constraints, ordered the same way as the per-path
 * query. The capsule renders these as `DO NOT RETRY`, so the order is part of
 * the artifact: blocking first, then most frequently observed, then newest.
 */
export async function listActiveConstraints(
  sql: Sql,
  projectId: string,
  branch: string,
  limit = 10,
): Promise<NegativeConstraint[]> {
  const result = await sql.execute({
    sql: `${SELECT}
           WHERE project_id = ? AND status = 'active'
             AND (branch IS NULL OR branch = ?)
           ORDER BY CASE severity WHEN 'blocking' THEN 0 ELSE 1 END,
                    occurrences DESC, created_at DESC, id ASC
           LIMIT ?`,
    args: [projectId, branch, limit],
  });
  return result.rows.map(toConstraint);
}
