import {
  ChronosError,
  type Clock,
  type IdGenerator,
  validateSlug,
} from "@chronos-ctx/shared-types";
import type { Database } from "../db/client.js";
import { type Branch, createBranch, getBranch, listBranches } from "../repositories/branches.js";
import {
  createProject,
  getProjectById,
  getProjectBySlug,
  listProjects,
  type Project,
} from "../repositories/projects.js";

export interface CreateProjectInput {
  slug: string;
  name: string;
  defaultBranch?: string;
  workspaceRoot?: string | null;
  objectStore?: "home" | "portable";
  indexMode?: "auto" | "flat" | "grouped";
  rootSummary?: string;
  activeObjective?: string | null;
}

export interface CreateProjectResult {
  project: Project;
  branch: Branch;
}

function requireSlug(value: string, field: string): string {
  const result = validateSlug(value);
  if (!result.ok) {
    throw new ChronosError(result.code, `${field}: ${result.reason}`, {
      details: { field, value },
    });
  }
  return result.path;
}

export class ProjectService {
  private readonly db: Database;
  private readonly ids: IdGenerator;
  private readonly clock: Clock;

  public constructor(options: { db: Database; ids: IdGenerator; clock: Clock }) {
    this.db = options.db;
    this.ids = options.ids;
    this.clock = options.clock;
  }

  /** Project plus its default branch exist together or not at all. */
  public async create(input: CreateProjectInput): Promise<CreateProjectResult> {
    const slug = requireSlug(input.slug, "slug");
    const branchName = requireSlug(input.defaultBranch ?? "main", "default_branch");
    const now = this.clock.now();

    return this.db.withTx(async (tx) => {
      const existing = await getProjectBySlug(tx, slug);
      if (existing !== null) {
        throw new ChronosError("CONFLICT", `project slug "${slug}" already exists`, {
          details: { project_id: existing.id },
        });
      }

      const project = await createProject(tx, {
        id: this.ids.id("prj"),
        slug,
        name: input.name,
        defaultBranch: branchName,
        now,
        workspaceRoot: input.workspaceRoot ?? null,
        ...(input.objectStore === undefined ? {} : { objectStore: input.objectStore }),
        ...(input.indexMode === undefined ? {} : { indexMode: input.indexMode }),
        ...(input.rootSummary === undefined ? {} : { rootSummary: input.rootSummary }),
        ...(input.activeObjective === undefined ? {} : { activeObjective: input.activeObjective }),
      });

      const branch = await createBranch(tx, {
        id: this.ids.id("brn"),
        projectId: project.id,
        name: branchName,
        now,
      });

      return { project, branch };
    });
  }

  /** Logical fork: a branch row that shares the version sequence (D1). */
  public async fork(
    projectId: string,
    name: string,
    options: { fromBranch?: string; fromCheckpointId?: string | null } = {},
  ): Promise<Branch> {
    const branchName = requireSlug(name, "branch");
    const now = this.clock.now();
    return this.db.withTx(async (tx) => {
      const project = await getProjectById(tx, projectId);
      if (project === null) {
        throw new ChronosError("PROJECT_NOT_FOUND", `project ${projectId} does not exist`);
      }
      const baseBranch = requireSlug(options.fromBranch ?? project.defaultBranch, "from_branch");
      const base = await getBranch(tx, projectId, baseBranch);
      if (base === null) {
        throw new ChronosError("BRANCH_NOT_FOUND", `branch "${baseBranch}" does not exist`);
      }
      const existing = await getBranch(tx, projectId, branchName);
      if (existing !== null) {
        throw new ChronosError("CONFLICT", `branch "${branchName}" already exists`, {
          details: { branch_id: existing.id },
        });
      }
      const headCheckpointId =
        options.fromCheckpointId === undefined ? base.headCheckpointId : options.fromCheckpointId;

      return createBranch(tx, {
        id: this.ids.id("brn"),
        projectId,
        name: branchName,
        now,
        forkedFromCheckpointId: headCheckpointId,
        baseBranch,
      });
    });
  }

  public async list(): Promise<Project[]> {
    return listProjects(this.db);
  }

  public async bySlug(slug: string): Promise<Project | null> {
    return getProjectBySlug(this.db, slug);
  }

  public async branches(projectId: string): Promise<Branch[]> {
    return listBranches(this.db, projectId);
  }
}
