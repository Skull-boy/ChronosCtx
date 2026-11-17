import { ChronosError } from "@chronos-ctx/shared-types";
import type { Row } from "@libsql/client";
import { integer, nullableInteger, nullableText, text } from "../db/rows.js";
import type { Sql } from "../db/sql.js";

export type VerificationKind =
  | "test_pass"
  | "build_pass"
  | "typecheck_pass"
  | "lint_pass"
  | "user_approval"
  | "import_trust"
  | "override";

export interface VerificationEvent {
  id: string;
  projectId: string;
  checkpointId: string | null;
  nodePaths: string[];
  coveredPaths: string[];
  treeHash: string | null;
  snapshotHash: string | null;
  kind: VerificationKind;
  command: string | null;
  exitCode: number | null;
  durationMs: number | null;
  cwd: string | null;
  logHash: string | null;
  logExcerpt: string | null;
  harness: string | null;
  verifiedBy: string | null;
  createdAt: number;
}

export interface CreateVerificationEventInput {
  id: string;
  projectId: string;
  checkpointId?: string | null;
  nodePaths?: string[];
  coveredPaths?: string[];
  treeHash?: string | null;
  snapshotHash?: string | null;
  kind: VerificationKind;
  command?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  cwd?: string | null;
  logHash?: string | null;
  logExcerpt?: string | null;
  harness?: string | null;
  verifiedBy?: string | null;
  now: number;
}

/** The 2 KB log cap is a schema rule, enforced before the insert (§4.2). */
export const LOG_EXCERPT_MAX_CHARS = 2048;

function parsePaths(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function toEvent(row: Row): VerificationEvent {
  return {
    id: text(row, "id"),
    projectId: text(row, "project_id"),
    checkpointId: nullableText(row, "checkpoint_id"),
    nodePaths: parsePaths(text(row, "node_paths_json")),
    coveredPaths: parsePaths(text(row, "covered_paths_json")),
    treeHash: nullableText(row, "tree_hash"),
    snapshotHash: nullableText(row, "snapshot_hash"),
    kind: text(row, "kind") as VerificationKind,
    command: nullableText(row, "command"),
    exitCode: nullableInteger(row, "exit_code"),
    durationMs: nullableInteger(row, "duration_ms"),
    cwd: nullableText(row, "cwd"),
    logHash: nullableText(row, "log_hash"),
    logExcerpt: nullableText(row, "log_excerpt"),
    harness: nullableText(row, "harness"),
    verifiedBy: nullableText(row, "verified_by"),
    createdAt: integer(row, "created_at"),
  };
}

export async function insertVerificationEvent(
  sql: Sql,
  input: CreateVerificationEventInput,
): Promise<VerificationEvent> {
  if (input.logExcerpt !== undefined && input.logExcerpt !== null) {
    if (input.logExcerpt.length > LOG_EXCERPT_MAX_CHARS) {
      throw new ChronosError(
        "NODE_INVALID",
        `log excerpt is ${input.logExcerpt.length} characters; the cap is ${LOG_EXCERPT_MAX_CHARS}`,
      );
    }
  }

  await sql.execute({
    sql: `INSERT INTO verification_events
            (id, project_id, checkpoint_id, node_paths_json, covered_paths_json,
             tree_hash, snapshot_hash, kind, command, exit_code, duration_ms, cwd,
             log_hash, log_excerpt, harness, verified_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      input.id,
      input.projectId,
      input.checkpointId ?? null,
      JSON.stringify(input.nodePaths ?? []),
      JSON.stringify(input.coveredPaths ?? []),
      input.treeHash ?? null,
      input.snapshotHash ?? null,
      input.kind,
      input.command ?? null,
      input.exitCode ?? null,
      input.durationMs ?? null,
      input.cwd ?? null,
      input.logHash ?? null,
      input.logExcerpt ?? null,
      input.harness ?? null,
      input.verifiedBy ?? null,
      input.now,
    ],
  });

  const created = await getVerificationEvent(sql, input.id);
  if (created === null) {
    throw new ChronosError("INTERNAL", "verification event missing after insert");
  }
  return created;
}

const SELECT = `SELECT id, project_id, checkpoint_id, node_paths_json, covered_paths_json,
                       tree_hash, snapshot_hash, kind, command, exit_code, duration_ms,
                       cwd, log_hash, log_excerpt, harness, verified_by, created_at
                FROM verification_events`;

export async function getVerificationEvent(
  sql: Sql,
  id: string,
): Promise<VerificationEvent | null> {
  const result = await sql.execute({ sql: `${SELECT} WHERE id = ?`, args: [id] });
  const row = result.rows[0];
  return row === undefined ? null : toEvent(row);
}

export async function listVerificationEvents(
  sql: Sql,
  projectId: string,
  limit = 50,
): Promise<VerificationEvent[]> {
  const result = await sql.execute({
    sql: `${SELECT} WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    args: [projectId, limit],
  });
  return result.rows.map(toEvent);
}
