import { ChronosError } from "@chronos-ctx/shared-types";
import type { Row } from "@libsql/client";
import { integer, nullableInteger, nullableText, text } from "../db/rows.js";
import type { Sql } from "../db/sql.js";

export type ObjectStore = "home" | "portable";
export type IndexMode = "auto" | "flat" | "grouped";

export interface Project {
  id: string;
  slug: string;
  name: string;
  rootSummary: string;
  activeObjective: string | null;
  defaultBranch: string;
  activeBranch: string;
  workspaceRoot: string | null;
  objectStore: ObjectStore;
  indexMode: IndexMode;
  schemaVersion: number;
  rev: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateProjectRecord {
  id: string;
  slug: string;
  name: string;
  defaultBranch: string;
  now: number;
  workspaceRoot?: string | null;
  objectStore?: ObjectStore;
  indexMode?: IndexMode;
  rootSummary?: string;
  activeObjective?: string | null;
}

function toProject(row: Row): Project {
  return {
    id: text(row, "id"),
    slug: text(row, "slug"),
    name: text(row, "name"),
    rootSummary: text(row, "root_summary"),
    activeObjective: nullableText(row, "active_objective"),
    defaultBranch: text(row, "default_branch"),
    activeBranch: text(row, "active_branch"),
    workspaceRoot: nullableText(row, "workspace_root"),
    objectStore: text(row, "object_store") as ObjectStore,
    indexMode: text(row, "index_mode") as IndexMode,
    schemaVersion: integer(row, "schema_version"),
    rev: integer(row, "rev"),
    createdAt: integer(row, "created_at"),
    updatedAt: integer(row, "updated_at"),
  };
}

const SELECT = `SELECT id, slug, name, root_summary, active_objective, default_branch,
                       active_branch, workspace_root, object_store, index_mode,
                       schema_version, rev, created_at, updated_at
                FROM projects`;

export async function createProject(sql: Sql, input: CreateProjectRecord): Promise<Project> {
  await sql.execute({
    sql: `INSERT INTO projects
            (id, slug, name, default_branch, active_branch, workspace_root,
             object_store, index_mode, root_summary, active_objective,
             created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      input.id,
      input.slug,
      input.name,
      input.defaultBranch,
      input.defaultBranch,
      input.workspaceRoot ?? null,
      input.objectStore ?? "home",
      input.indexMode ?? "auto",
      input.rootSummary ?? "",
      input.activeObjective ?? null,
      input.now,
      input.now,
    ],
  });
  const created = await getProjectById(sql, input.id);
  if (created === null) {
    throw new ChronosError("INTERNAL", `project ${input.id} was not readable after insert`);
  }
  return created;
}

export async function getProjectById(sql: Sql, id: string): Promise<Project | null> {
  const result = await sql.execute({ sql: `${SELECT} WHERE id = ?`, args: [id] });
  const row = result.rows[0];
  return row === undefined ? null : toProject(row);
}

export async function getProjectBySlug(sql: Sql, slug: string): Promise<Project | null> {
  const result = await sql.execute({ sql: `${SELECT} WHERE slug = ?`, args: [slug] });
  const row = result.rows[0];
  return row === undefined ? null : toProject(row);
}

export async function listProjects(sql: Sql, includeDeleted = false): Promise<Project[]> {
  const where = includeDeleted ? "" : " WHERE deleted_at IS NULL";
  const result = await sql.execute(`${SELECT}${where} ORDER BY created_at ASC`);
  return result.rows.map(toProject);
}

/** UI preference only; never a source of truth for history (ADR-0016). */
export async function setActiveBranch(
  sql: Sql,
  projectId: string,
  branch: string,
  now: number,
): Promise<void> {
  const result = await sql.execute({
    sql: "UPDATE projects SET active_branch = ?, updated_at = ? WHERE id = ?",
    args: [branch, now, projectId],
  });
  if (result.rowsAffected === 0) {
    throw new ChronosError("PROJECT_NOT_FOUND", `project ${projectId} does not exist`);
  }
}

export async function countProjects(sql: Sql): Promise<number> {
  const result = await sql.execute("SELECT count(*) AS n FROM projects WHERE deleted_at IS NULL");
  const row = result.rows[0];
  return row === undefined ? 0 : (nullableInteger(row, "n") ?? 0);
}
