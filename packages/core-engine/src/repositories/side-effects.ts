import type { Row } from "@libsql/client";
import { integer, nullableText, text } from "../db/rows.js";
import type { Sql } from "../db/sql.js";

export type SideEffectKind =
  | "package_install"
  | "migration"
  | "external_write"
  | "remote_push"
  | "email"
  | "cloud_resource"
  | "other";

export interface SideEffect {
  id: string;
  projectId: string;
  branch: string;
  checkpointId: string | null;
  kind: SideEffectKind;
  description: string;
  command: string | null;
  reversible: boolean;
  undoHint: string | null;
  reportedBy: string | null;
  createdAt: number;
}

function toSideEffect(row: Row): SideEffect {
  return {
    id: text(row, "id"),
    projectId: text(row, "project_id"),
    branch: text(row, "branch"),
    checkpointId: nullableText(row, "checkpoint_id"),
    kind: text(row, "kind") as SideEffectKind,
    description: text(row, "description"),
    command: nullableText(row, "command"),
    reversible: integer(row, "reversible") === 1,
    undoHint: nullableText(row, "undo_hint"),
    reportedBy: nullableText(row, "reported_by"),
    createdAt: integer(row, "created_at"),
  };
}

const SELECT = `SELECT id, project_id, branch, checkpoint_id, kind, description,
                       command, reversible, undo_hint, reported_by, created_at
                FROM side_effects`;

/**
 * Side effects inside a checkpoint's time range, newest first. The range is
 * half-open on the left so a checkpoint does not claim the effects of the one
 * before it: `(parent.created_at, checkpoint.created_at]`.
 *
 * These are reported, never reversed. A capsule that omits them would claim a
 * rewind undid a migration or a push.
 */
export async function listSideEffectsInRange(
  sql: Sql,
  projectId: string,
  branch: string,
  fromExclusive: number,
  toInclusive: number,
  limit = 10,
): Promise<SideEffect[]> {
  const result = await sql.execute({
    sql: `${SELECT}
           WHERE project_id = ? AND branch = ?
             AND created_at > ? AND created_at <= ?
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
    args: [projectId, branch, fromExclusive, toInclusive, limit],
  });
  return result.rows.map(toSideEffect);
}
