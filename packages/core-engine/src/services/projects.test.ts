import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Clock, createIdGenerator, type IdGenerator } from "@chronos-ctx/shared-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../db/client.js";
import { migrate } from "../db/migrate.js";
import { type Engine, openEngine } from "../engine.js";
import { listBranches } from "../repositories/branches.js";

class TestClock implements Clock {
  public t = Date.UTC(2026, 0, 1);

  public now(): number {
    return this.t;
  }
}

let dir: string | undefined;
let db: Database | undefined;
let engine: Engine;
let clock: TestClock;
let ids: IdGenerator;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "chronos-projects-"));
  db = await openDatabase({ file: join(dir, "chronos.db") });
  await migrate(db);
  clock = new TestClock();
  ids = createIdGenerator({ clock, deterministic: true });
  engine = await openEngine({ database: db, clock, ids, migrate: false });
});

afterEach(() => {
  engine?.close();
  db?.close();
  db = undefined;
  if (dir) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      // Windows can hold a WAL handle briefly.
    }
  }
  dir = undefined;
});

describe("project creation", () => {
  it("creates a project and its default branch atomically", async () => {
    const { project, branch } = await engine.projects.create({
      slug: "Toy API",
      name: "Toy API",
      activeObjective: "Ship refresh-token rotation",
    });

    expect(project.slug).toBe("toy-api");
    expect(project.defaultBranch).toBe("main");
    expect(project.activeBranch).toBe("main");
    expect(project.objectStore).toBe("home");
    expect(branch.name).toBe("main");
    expect(branch.projectId).toBe(project.id);

    const branches = await listBranches(db as Database, project.id);
    expect(branches.map((row) => row.name)).toEqual(["main"]);
  });

  it("uses a custom default branch", async () => {
    const { project, branch } = await engine.projects.create({
      slug: "toy-api",
      name: "Toy API",
      defaultBranch: "trunk",
    });
    expect(project.defaultBranch).toBe("trunk");
    expect(branch.name).toBe("trunk");
  });

  it("refuses a duplicate slug without creating a second branch", async () => {
    await engine.projects.create({ slug: "toy-api", name: "Toy API" });
    await expect(engine.projects.create({ slug: "toy-api", name: "Copy" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(
      await listBranches(db as Database, (await engine.projects.bySlug("toy-api"))?.id ?? ""),
    ).toHaveLength(1);
  });

  it("refuses an invalid slug", async () => {
    await expect(engine.projects.create({ slug: "a/b", name: "Bad" })).rejects.toMatchObject({
      code: "PATH_INVALID",
    });
  });

  it("is readable by slug and listed", async () => {
    const { project } = await engine.projects.create({ slug: "toy-api", name: "Toy API" });
    expect((await engine.projects.bySlug("toy-api"))?.id).toBe(project.id);
    expect((await engine.projects.list()).map((row) => row.id)).toContain(project.id);
  });
});

describe("logical fork", () => {
  it("creates a branch with base and fork-point metadata", async () => {
    const { project } = await engine.projects.create({ slug: "toy-api", name: "Toy API" });
    const branch = await engine.projects.fork(project.id, "redis-rate-limit");
    expect(branch.baseBranch).toBe("main");
    expect(branch.status).toBe("active");
    expect(branch.headCheckpointId).toBeNull();

    const all = await listBranches(db as Database, project.id);
    expect(all.map((row) => row.name).sort()).toEqual(["main", "redis-rate-limit"]);
  });

  it("refuses an unknown base branch", async () => {
    const { project } = await engine.projects.create({ slug: "toy-api", name: "Toy API" });
    await expect(
      engine.projects.fork(project.id, "x", { fromBranch: "missing" }),
    ).rejects.toMatchObject({ code: "BRANCH_NOT_FOUND" });
  });

  it("refuses a duplicate branch name", async () => {
    const { project } = await engine.projects.create({ slug: "toy-api", name: "Toy API" });
    await engine.projects.fork(project.id, "side");
    await expect(engine.projects.fork(project.id, "side")).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("refuses to fork an unknown project", async () => {
    await expect(engine.projects.fork("prj_missing", "side")).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
    });
  });
});
