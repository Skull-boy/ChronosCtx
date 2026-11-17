import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Clock, createIdGenerator, type IdGenerator } from "@chronos-ctx/shared-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../db/client.js";
import { migrate } from "../db/migrate.js";
import { type Engine, openEngine } from "../engine.js";

class TestClock implements Clock {
  public t = Date.UTC(2026, 0, 1);

  public now(): number {
    this.t += 1;
    return this.t;
  }
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let dir: string | undefined;
let db: Database | undefined;
let engine: Engine;
let ids: IdGenerator;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "chronos-interleave-"));
  db = await openDatabase({ file: join(dir, "chronos.db") });
  await migrate(db);
  const clock = new TestClock();
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

describe("fork/commit interleavings (gate 1.11)", () => {
  it("1,000 randomized commits across 3 branches produce zero duplicate (path, version)", async () => {
    const created = await engine.projects.create({ slug: "toy-api", name: "Toy API" });
    const projectId = created.project.id;
    await engine.projects.fork(projectId, "side-a");
    await engine.projects.fork(projectId, "side-b");

    const branches = ["main", "side-a", "side-b"];
    const paths = ["db/schema", "auth/jwt", "api/routes", "tasks/active", "docs/runbook"];
    const random = mulberry32(20261117);

    for (let i = 0; i < 1000; i += 1) {
      const branch = branches[Math.floor(random() * branches.length)] ?? "main";
      const path = paths[Math.floor(random() * paths.length)] ?? "db/schema";
      await engine.commit.commit({
        projectId,
        branch,
        path,
        title: path,
        summary: `summary ${i}`,
        content: `revision ${i}`,
        sourceSurface: "opencode-cli",
        author: "agent:test",
      });
    }

    const database = db as Database;

    const duplicates = await database.execute(
      `SELECT node_path, version, count(*) AS n
           FROM node_versions
          GROUP BY node_path, version
         HAVING n > 1`,
    );
    expect(duplicates.rows).toHaveLength(0);

    // A project-global sequence per path means versions start at 1 and are
    // contiguous: count == max, min == 1. Gaps are only legal when a fork
    // skips numbers, which this workload never does.
    const sequences = await database.execute(
      `SELECT node_path, count(*) AS n, max(version) AS max_version, min(version) AS min_version
           FROM node_versions
          GROUP BY node_path`,
    );
    expect(sequences.rows).toHaveLength(paths.length);
    for (const row of sequences.rows) {
      expect(Number(row.n)).toBe(Number(row.max_version));
      expect(Number(row.min_version)).toBe(1);
    }

    // Every head points at a version with the same number and status.
    const mismatched = await database.execute(
      `SELECT count(*) AS n
           FROM state_nodes n
           JOIN node_versions v ON v.version_id = n.head_version_id
          WHERE n.version <> v.version OR n.status <> v.status`,
    );
    expect(Number(mismatched.rows[0]?.n)).toBe(0);

    // Provenance is always a branch this project actually has.
    const unknownBranch = await database.execute(
      `SELECT count(*) AS n FROM node_versions
          WHERE created_on_branch NOT IN ('main','side-a','side-b')`,
    );
    expect(Number(unknownBranch.rows[0]?.n)).toBe(0);

    const selfSupersede = await database.execute(
      "SELECT count(*) AS n FROM node_versions WHERE supersedes_version_id = version_id",
    );
    expect(Number(selfSupersede.rows[0]?.n)).toBe(0);

    const versionCount = await database.execute("SELECT count(*) AS n FROM node_versions");
    expect(Number(versionCount.rows[0]?.n)).toBe(1000);

    const headCount = await database.execute("SELECT count(*) AS n FROM state_nodes");
    // Five paths on each of three branches, all touched by the workload.
    expect(Number(headCount.rows[0]?.n)).toBe(paths.length * branches.length);
  }, 180_000);
});
