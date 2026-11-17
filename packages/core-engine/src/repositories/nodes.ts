import { ChronosError, type NodeStatus, type SourceSurface } from "@chronos-ctx/shared-types";
import type { Row } from "@libsql/client";
import { integer, nullableInteger, nullableText, text } from "../db/rows.js";
import type { Sql } from "../db/sql.js";

export interface NodeHead {
  id: string;
  projectId: string;
  branch: string;
  path: string;
  headVersionId: string;
  version: number;
  status: NodeStatus;
  updatedAt: number;
}

export interface NodeVersionRow {
  versionId: string;
  projectId: string;
  nodePath: string;
  version: number;
  title: string;
  summary: string;
  content: string;
  contentHash: string;
  status: NodeStatus;
  sourceSurface: SourceSurface;
  sourceRef: string | null;
  author: string | null;
  createdOnBranch: string;
  verificationEventId: string | null;
  verifiedTreeHash: string | null;
  supersedesVersionId: string | null;
  forkedFromVersionId: string | null;
  tokensEstimate: number;
  createdAt: number;
}

export interface NodeView extends NodeVersionRow {
  headId: string;
  branch: string;
  updatedAt: number;
}

function toHead(row: Row): NodeHead {
  return {
    id: text(row, "id"),
    projectId: text(row, "project_id"),
    branch: text(row, "branch"),
    path: text(row, "path"),
    headVersionId: text(row, "head_version_id"),
    version: integer(row, "version"),
    status: text(row, "status") as NodeStatus,
    updatedAt: integer(row, "updated_at"),
  };
}

function toVersion(row: Row): NodeVersionRow {
  return {
    versionId: text(row, "version_id"),
    projectId: text(row, "project_id"),
    nodePath: text(row, "node_path"),
    version: integer(row, "version"),
    title: text(row, "title"),
    summary: text(row, "summary"),
    content: text(row, "content"),
    contentHash: text(row, "content_hash"),
    status: text(row, "status") as NodeStatus,
    sourceSurface: text(row, "source_surface") as SourceSurface,
    sourceRef: nullableText(row, "source_ref"),
    author: nullableText(row, "author"),
    createdOnBranch: text(row, "created_on_branch"),
    verificationEventId: nullableText(row, "verification_event_id"),
    verifiedTreeHash: nullableText(row, "verified_tree_hash"),
    supersedesVersionId: nullableText(row, "supersedes_version_id"),
    forkedFromVersionId: nullableText(row, "forked_from_version_id"),
    tokensEstimate: integer(row, "tokens_estimate"),
    createdAt: integer(row, "created_at"),
  };
}

const HEAD_SELECT = `SELECT id, project_id, branch, path, head_version_id, version, status, updated_at
                     FROM state_nodes`;

const VERSION_SELECT = `SELECT version_id, project_id, node_path, version, title, summary, content,
                               content_hash, status, source_surface, source_ref, author,
                               created_on_branch, verification_event_id, verified_tree_hash,
                               supersedes_version_id, forked_from_version_id, tokens_estimate,
                               created_at
                        FROM node_versions`;

export async function getHead(
  sql: Sql,
  projectId: string,
  branch: string,
  path: string,
): Promise<NodeHead | null> {
  const result = await sql.execute({
    sql: `${HEAD_SELECT} WHERE project_id = ? AND branch = ? AND path = ?`,
    args: [projectId, branch, path],
  });
  const row = result.rows[0];
  return row === undefined ? null : toHead(row);
}

export async function getVersion(sql: Sql, versionId: string): Promise<NodeVersionRow | null> {
  const result = await sql.execute({
    sql: `${VERSION_SELECT} WHERE version_id = ?`,
    args: [versionId],
  });
  const row = result.rows[0];
  return row === undefined ? null : toVersion(row);
}

/** Head + version detail in one round trip; the read path for page_in. */
export async function getNodeView(
  sql: Sql,
  projectId: string,
  branch: string,
  path: string,
): Promise<NodeView | null> {
  const result = await sql.execute({
    sql: `SELECT n.id AS head_id, n.branch AS branch, n.updated_at AS head_updated_at,
                 v.version_id, v.project_id, v.node_path, v.version, v.title, v.summary,
                 v.content, v.content_hash, v.status, v.source_surface, v.source_ref,
                 v.author, v.created_on_branch, v.verification_event_id,
                 v.verified_tree_hash, v.supersedes_version_id, v.forked_from_version_id,
                 v.tokens_estimate, v.created_at
            FROM state_nodes n
            JOIN node_versions v ON v.version_id = n.head_version_id
           WHERE n.project_id = ? AND n.branch = ? AND n.path = ?`,
    args: [projectId, branch, path],
  });
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    ...toVersion(row),
    headId: text(row, "head_id"),
    branch: text(row, "branch"),
    updatedAt: integer(row, "head_updated_at"),
  };
}

export interface ListHeadsOptions {
  status?: NodeStatus;
  limit?: number;
}

export interface HeadSummary extends NodeHead {
  title: string;
  summary: string;
}

export async function listHeads(
  sql: Sql,
  projectId: string,
  branch: string,
  options: ListHeadsOptions = {},
): Promise<NodeHead[]> {
  const args: Array<string | number> = [projectId, branch];
  let where = " WHERE project_id = ? AND branch = ?";
  if (options.status !== undefined) {
    where += " AND status = ?";
    args.push(options.status);
  }
  let sqlText = `${HEAD_SELECT}${where} ORDER BY path ASC`;
  if (options.limit !== undefined) {
    sqlText += " LIMIT ?";
    args.push(options.limit);
  }
  const result = await sql.execute({ sql: sqlText, args });
  return result.rows.map(toHead);
}

export async function listHeadSummaries(
  sql: Sql,
  projectId: string,
  branch: string,
): Promise<HeadSummary[]> {
  const result = await sql.execute({
    sql: `SELECT n.id, n.project_id, n.branch, n.path, n.head_version_id, n.version,
                 n.status, n.updated_at, v.title, v.summary
            FROM state_nodes n
            JOIN node_versions v ON v.version_id = n.head_version_id
           WHERE n.project_id = ? AND n.branch = ?
           ORDER BY n.path ASC`,
    args: [projectId, branch],
  });
  return result.rows.map((row) => ({
    ...toHead(row),
    title: text(row, "title"),
    summary: text(row, "summary"),
  }));
}

export async function maxVersionNumber(
  sql: Sql,
  projectId: string,
  nodePath: string,
): Promise<number> {
  const result = await sql.execute({
    sql: "SELECT MAX(version) AS max_version FROM node_versions WHERE project_id = ? AND node_path = ?",
    args: [projectId, nodePath],
  });
  const row = result.rows[0];
  return row === undefined ? 0 : (nullableInteger(row, "max_version") ?? 0);
}

export async function insertVersion(sql: Sql, row: NodeVersionRow): Promise<void> {
  await sql.execute({
    sql: `INSERT INTO node_versions
            (version_id, project_id, node_path, version, title, summary, content,
             content_hash, status, source_surface, source_ref, author,
             created_on_branch, verification_event_id, verified_tree_hash,
             supersedes_version_id, forked_from_version_id, tokens_estimate, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      row.versionId,
      row.projectId,
      row.nodePath,
      row.version,
      row.title,
      row.summary,
      row.content,
      row.contentHash,
      row.status,
      row.sourceSurface,
      row.sourceRef,
      row.author,
      row.createdOnBranch,
      row.verificationEventId,
      row.verifiedTreeHash,
      row.supersedesVersionId,
      row.forkedFromVersionId,
      row.tokensEstimate,
      row.createdAt,
    ],
  });
}

export interface UpsertHeadInput {
  id: string;
  projectId: string;
  branch: string;
  path: string;
  headVersionId: string;
  version: number;
  status: NodeStatus;
  updatedAt: number;
}

export async function upsertHead(sql: Sql, input: UpsertHeadInput): Promise<void> {
  await sql.execute({
    sql: `INSERT INTO state_nodes
            (id, project_id, branch, path, head_version_id, version, status, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (project_id, branch, path) DO UPDATE SET
            head_version_id = excluded.head_version_id,
            version         = excluded.version,
            status          = excluded.status,
            updated_at      = excluded.updated_at`,
    args: [
      input.id,
      input.projectId,
      input.branch,
      input.path,
      input.headVersionId,
      input.version,
      input.status,
      input.updatedAt,
    ],
  });
}

export async function deleteHead(
  sql: Sql,
  projectId: string,
  branch: string,
  path: string,
): Promise<boolean> {
  const result = await sql.execute({
    sql: "DELETE FROM state_nodes WHERE project_id = ? AND branch = ? AND path = ?",
    args: [projectId, branch, path],
  });
  return result.rowsAffected > 0;
}

export async function insertAlias(
  sql: Sql,
  input: {
    projectId: string;
    branch: string;
    oldPath: string;
    newPath: string;
    now: number;
  },
): Promise<void> {
  await sql.execute({
    sql: `INSERT INTO node_aliases (project_id, branch, old_path, new_path, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (project_id, branch, old_path) DO UPDATE SET new_path = excluded.new_path`,
    args: [input.projectId, input.branch, input.oldPath, input.newPath, input.now],
  });
}

export interface AliasResolution {
  path: string;
  /** Old paths traversed, nearest first. Empty when the path is already current. */
  aliases: string[];
}

const MAX_ALIAS_HOPS = 8;

/**
 * Follows `node_aliases` until a path stops moving. A cycle is refused rather
 * than followed: it can only arise from a bug, and looping on it would turn a
 * bad rename into a hang.
 */
export async function resolveAlias(
  sql: Sql,
  projectId: string,
  branch: string,
  path: string,
): Promise<AliasResolution> {
  let current = path;
  const aliases: string[] = [];
  const seen = new Set<string>([current]);

  for (let hop = 0; hop < MAX_ALIAS_HOPS; hop += 1) {
    const result = await sql.execute({
      sql: "SELECT new_path FROM node_aliases WHERE project_id = ? AND branch = ? AND old_path = ?",
      args: [projectId, branch, current],
    });
    const row = result.rows[0];
    if (row === undefined) return { path: current, aliases };
    const next = nullableText(row, "new_path");
    if (next === null) return { path: current, aliases };
    if (seen.has(next)) {
      throw new ChronosError("INTERNAL", `alias cycle at "${next}"`, {
        details: { project_id: projectId, branch, path },
      });
    }
    aliases.push(current);
    seen.add(next);
    current = next;
  }

  throw new ChronosError("INTERNAL", `alias chain for "${path}" exceeds ${MAX_ALIAS_HOPS} hops`);
}

export async function listAliases(
  sql: Sql,
  projectId: string,
  branch: string,
): Promise<Array<{ oldPath: string; newPath: string }>> {
  const result = await sql.execute({
    sql: "SELECT old_path, new_path FROM node_aliases WHERE project_id = ? AND branch = ? ORDER BY created_at ASC",
    args: [projectId, branch],
  });
  return result.rows.map((row) => ({
    oldPath: text(row, "old_path"),
    newPath: text(row, "new_path"),
  }));
}
