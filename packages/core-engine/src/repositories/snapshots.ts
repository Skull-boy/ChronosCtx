import { ChronosError } from "@chronos-ctx/shared-types";
import type { Row } from "@libsql/client";
import { blob, integer, text } from "../db/rows.js";
import type { Sql } from "../db/sql.js";

export interface Snapshot {
  id: string;
  projectId: string;
  snapshotHash: string;
  contentRoot: string;
  kind: "state";
  body: Uint8Array;
  nodeCount: number;
  bytes: number;
  createdAt: number;
}

export interface EnsureSnapshotInput {
  id: string;
  projectId: string;
  snapshotHash: string;
  contentRoot: string;
  body: Uint8Array;
  nodeCount: number;
  bytes: number;
  now: number;
}

export interface EnsureSnapshotResult {
  snapshot: Snapshot;
  inserted: boolean;
}

function toSnapshot(row: Row): Snapshot {
  return {
    id: text(row, "id"),
    projectId: text(row, "project_id"),
    snapshotHash: text(row, "snapshot_hash"),
    contentRoot: text(row, "content_root"),
    kind: text(row, "kind") as "state",
    body: blob(row, "body_zstd"),
    nodeCount: integer(row, "node_count"),
    bytes: integer(row, "bytes"),
    createdAt: integer(row, "created_at"),
  };
}

const SELECT = `SELECT id, project_id, snapshot_hash, content_root, kind, body_zstd,
                       node_count, bytes, created_at
                FROM snapshots`;

/**
 * D5: identical state is written once. `ON CONFLICT DO NOTHING` plus the
 * schema-level UNIQUE constraint is the mechanism; `rowsAffected` tells the
 * caller whether bytes were actually written, which is what `chronos stats
 * --dedupe` reports.
 */
export async function ensureSnapshot(
  sql: Sql,
  input: EnsureSnapshotInput,
): Promise<EnsureSnapshotResult> {
  const write = await sql.execute({
    sql: `INSERT INTO snapshots
            (id, project_id, snapshot_hash, content_root, kind, body_zstd,
             node_count, bytes, created_at)
          VALUES (?, ?, ?, ?, 'state', ?, ?, ?, ?)
          ON CONFLICT (project_id, snapshot_hash, kind) DO NOTHING`,
    args: [
      input.id,
      input.projectId,
      input.snapshotHash,
      input.contentRoot,
      input.body,
      input.nodeCount,
      input.bytes,
      input.now,
    ],
  });

  const existing = await sql.execute({
    sql: `${SELECT} WHERE project_id = ? AND snapshot_hash = ? AND kind = 'state'`,
    args: [input.projectId, input.snapshotHash],
  });
  const row = existing.rows[0];
  if (row === undefined) {
    throw new ChronosError("INTERNAL", "snapshot row missing after insert");
  }
  return { snapshot: toSnapshot(row), inserted: write.rowsAffected > 0 };
}

export async function getSnapshot(sql: Sql, id: string): Promise<Snapshot | null> {
  const result = await sql.execute({ sql: `${SELECT} WHERE id = ?`, args: [id] });
  const row = result.rows[0];
  return row === undefined ? null : toSnapshot(row);
}

export async function findByContentRoot(
  sql: Sql,
  projectId: string,
  contentRoot: string,
): Promise<Snapshot[]> {
  const result = await sql.execute({
    sql: `${SELECT} WHERE project_id = ? AND content_root = ? ORDER BY created_at ASC`,
    args: [projectId, contentRoot],
  });
  return result.rows.map(toSnapshot);
}

export interface SnapshotStats {
  rows: number;
  distinctContentRoots: number;
  bytes: number;
}

export async function snapshotStats(sql: Sql, projectId: string): Promise<SnapshotStats> {
  const result = await sql.execute({
    sql: `SELECT count(*) AS rows,
                 count(DISTINCT content_root) AS roots,
                 coalesce(sum(bytes), 0) AS bytes
            FROM snapshots WHERE project_id = ?`,
    args: [projectId],
  });
  const row = result.rows[0];
  if (row === undefined) return { rows: 0, distinctContentRoots: 0, bytes: 0 };
  return {
    rows: integer(row, "rows"),
    distinctContentRoots: integer(row, "roots"),
    bytes: integer(row, "bytes"),
  };
}
