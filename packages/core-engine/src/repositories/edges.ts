import { ChronosError, validatePath } from "@chronos-ctx/shared-types";
import type { Row } from "@libsql/client";
import { nullableText, real, text } from "../db/rows.js";
import type { Sql } from "../db/sql.js";

export type EdgeRel =
  | "depends_on"
  | "implements"
  | "supersedes"
  | "contradicts"
  | "documents"
  | "tests"
  | "blocks"
  | "related_to";

export const EDGE_RELS: ReadonlySet<EdgeRel> = new Set<EdgeRel>([
  "depends_on",
  "implements",
  "supersedes",
  "contradicts",
  "documents",
  "tests",
  "blocks",
  "related_to",
]);

export type EdgeOrigin = "manual" | "inferred" | "import" | "merge";

export interface Neighbor {
  rel: EdgeRel;
  toPath: string;
  summary: string | null;
  weight: number;
}

export interface CreateEdgeInput {
  id: string;
  projectId: string;
  fromPath: string;
  toPath: string;
  rel: EdgeRel;
  weight?: number;
  origin?: EdgeOrigin;
  now: number;
}

export async function createEdge(sql: Sql, input: CreateEdgeInput): Promise<void> {
  const from = validatePath(input.fromPath);
  const to = validatePath(input.toPath);
  if (!from.ok) throw new ChronosError(from.code, `from_path: ${from.reason}`);
  if (!to.ok) throw new ChronosError(to.code, `to_path: ${to.reason}`);
  if (from.path === to.path) {
    throw new ChronosError("NODE_INVALID", "an edge cannot point at its own node");
  }
  if (!EDGE_RELS.has(input.rel)) {
    throw new ChronosError("NODE_INVALID", `unknown edge relation "${input.rel}"`);
  }

  await sql.execute({
    sql: `INSERT INTO node_edges
            (id, project_id, from_path, to_path, rel, weight, origin, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (project_id, from_path, to_path, rel) DO NOTHING`,
    args: [
      input.id,
      input.projectId,
      from.path,
      to.path,
      input.rel,
      input.weight ?? 1.0,
      input.origin ?? "manual",
      input.now,
    ],
  });
}

/**
 * One-hop neighbours with the target's current summary. Edges are version
 * agnostic by endpoint; the summary is resolved against the requested branch and
 * is null when the target has no head there.
 */
export async function listNeighbors(
  sql: Sql,
  projectId: string,
  branch: string,
  fromPath: string,
  rels: readonly EdgeRel[],
  limit = 9,
): Promise<Neighbor[]> {
  if (rels.length === 0) return [];
  const placeholders = rels.map(() => "?").join(", ");
  const result = await sql.execute({
    sql: `SELECT e.rel, e.to_path, e.weight, v.summary
            FROM node_edges e
            LEFT JOIN state_nodes n
              ON n.project_id = e.project_id AND n.branch = ? AND n.path = e.to_path
            LEFT JOIN node_versions v ON v.version_id = n.head_version_id
           WHERE e.project_id = ? AND e.from_path = ? AND e.rel IN (${placeholders})
           ORDER BY e.weight DESC, e.to_path ASC
           LIMIT ?`,
    args: [branch, projectId, fromPath, ...rels, limit],
  });
  return result.rows.map(toNeighbor);
}

function toNeighbor(row: Row): Neighbor {
  return {
    rel: text(row, "rel") as EdgeRel,
    toPath: text(row, "to_path"),
    summary: nullableText(row, "summary"),
    weight: real(row, "weight"),
  };
}
