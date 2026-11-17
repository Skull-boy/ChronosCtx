import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Clock, createIdGenerator, type IdGenerator } from "@chronos-ctx/shared-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeSnapshotBody } from "../content/snapshot.js";
import { type Database, openDatabase } from "../db/client.js";
import { migrate } from "../db/migrate.js";
import { type Engine, openEngine } from "../engine.js";

async function countSnapshots(sql: Database): Promise<number> {
  const result = await sql.execute("SELECT count(*) AS n FROM snapshots");
  const row = result.rows[0];
  return row === undefined ? 0 : Number(row.n);
}

async function findSnapshotByHash(
  sql: Database,
  projectId: string,
  snapshotHash: string,
): Promise<{ contentRoot: string; createdAt: number } | null> {
  const result = await sql.execute({
    sql: "SELECT content_root, created_at FROM snapshots WHERE project_id = ? AND snapshot_hash = ?",
    args: [projectId, snapshotHash],
  });
  const row = result.rows[0];
  if (row === undefined) return null;
  return { contentRoot: String(row.content_root), createdAt: Number(row.created_at) };
}

class TestClock implements Clock {
  public t = Date.UTC(2026, 0, 1, 0, 0, 0);

  public now(): number {
    return this.t;
  }

  public advance(ms = 1000): void {
    this.t += ms;
  }
}

let dir: string | undefined;
let db: Database | undefined;
let engine: Engine;
let clock: TestClock;
let ids: IdGenerator;
let projectId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "chronos-chk-"));
  db = await openDatabase({ file: join(dir, "chronos.db") });
  await migrate(db);
  clock = new TestClock();
  ids = createIdGenerator({ clock, deterministic: true });
  engine = await openEngine({ database: db, clock, ids, migrate: false });
  const created = await engine.projects.create({ slug: "toy-api", name: "Toy API" });
  projectId = created.project.id;
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

async function commit(path: string, content: string): Promise<void> {
  clock.advance();
  await engine.commit.commit({
    projectId,
    branch: "main",
    path,
    title: path,
    summary: `summary for ${path}`,
    content,
    sourceSurface: "opencode-cli",
  });
}

describe("state-only checkpoints (D6)", () => {
  it("creates a snapshot, a checkpoint and moves the branch head", async () => {
    await commit("db/schema", "tables");
    await commit("auth/jwt", "RS256");

    clock.advance();
    const first = await engine.checkpoints.createStateOnly({
      projectId,
      branch: "main",
      message: "first",
    });

    expect(first.checkpoint.snapshotKind).toBe("state_only");
    expect(first.checkpoint.storage).toBe("none");
    expect(first.checkpoint.gitTreeHash).toBeNull();
    expect(first.checkpoint.parentCheckpointId).toBeNull();
    expect(first.checkpoint.nodeCount).toBe(2);
    expect(first.deduped).toBe(false);
    expect(first.snapshot.nodeCount).toBe(2);

    const head = await engine.checkpoints.head(projectId, "main");
    expect(head?.checkpointId).toBe(first.checkpoint.checkpointId);
  });

  it("chains parent checkpoints", async () => {
    await commit("db/schema", "tables");
    clock.advance();
    const first = await engine.checkpoints.createStateOnly({ projectId, branch: "main" });
    clock.advance();
    const second = await engine.checkpoints.createStateOnly({ projectId, branch: "main" });
    expect(second.checkpoint.parentCheckpointId).toBe(first.checkpoint.checkpointId);
  });

  it("dedupes an unchanged state and writes zero new bytes", async () => {
    await commit("db/schema", "tables");
    clock.advance();
    const first = await engine.checkpoints.createStateOnly({ projectId, branch: "main" });
    clock.advance();
    const second = await engine.checkpoints.createStateOnly({ projectId, branch: "main" });

    expect(second.deduped).toBe(true);
    expect(second.snapshot.id).toBe(first.snapshot.id);
    expect(await countSnapshots(db as Database)).toBe(1);
  });

  it("stores the decoded body as canonical path/version pairs", async () => {
    await commit("db/schema", "tables");
    await commit("auth/jwt", "RS256");
    clock.advance();
    const result = await engine.checkpoints.createStateOnly({ projectId, branch: "main" });
    const entries = decodeSnapshotBody(result.snapshot.body);
    expect(entries.map((entry) => entry.path)).toEqual(["auth/jwt", "db/schema"]);
  });
});

describe("snapshot dedupe and portable identity (D5)", () => {
  it("200 checkpoints over 3 distinct states produce exactly 3 rows", async () => {
    await commit("a", "one");
    await commit("b", "two");
    clock.advance();
    await engine.checkpoints.createStateOnly({ projectId, branch: "main" });

    for (let i = 0; i < 98; i += 1) {
      clock.advance();
      await engine.checkpoints.createStateOnly({ projectId, branch: "main" });
    }

    await commit("a", "one-changed");
    clock.advance();
    await engine.checkpoints.createStateOnly({ projectId, branch: "main" });
    for (let i = 0; i < 49; i += 1) {
      clock.advance();
      await engine.checkpoints.createStateOnly({ projectId, branch: "main" });
    }

    await commit("b", "two-changed");
    clock.advance();
    await engine.checkpoints.createStateOnly({ projectId, branch: "main" });
    for (let i = 0; i < 49; i += 1) {
      clock.advance();
      await engine.checkpoints.createStateOnly({ projectId, branch: "main" });
    }

    const stats = await engine.snapshots.stats(projectId);
    expect(stats.rows).toBe(3);
    expect(stats.distinctContentRoots).toBe(3);
  });

  it("different version ids with equal content share content_root but stay two rows", async () => {
    await commit("a", "same text");
    clock.advance();
    const first = await engine.checkpoints.createStateOnly({ projectId, branch: "main" });

    // Re-committing identical text mints a new version id with the same
    // content_hash: the local state changed, the knowledge did not.
    clock.advance();
    await engine.commit.commit({
      projectId,
      branch: "main",
      path: "a",
      title: "a",
      summary: "summary for a",
      content: "same text",
      sourceSurface: "opencode-cli",
    });
    clock.advance();
    const second = await engine.checkpoints.createStateOnly({ projectId, branch: "main" });

    expect(second.snapshot.id).not.toBe(first.snapshot.id);
    expect(second.snapshot.snapshotHash).not.toBe(first.snapshot.snapshotHash);
    expect(second.snapshot.contentRoot).toBe(first.snapshot.contentRoot);
    expect(await countSnapshots(db as Database)).toBe(2);

    const stored = await findSnapshotByHash(
      db as Database,
      projectId,
      second.snapshot.snapshotHash,
    );
    expect(stored?.contentRoot).toBe(first.snapshot.contentRoot);
  });
});

describe("checkpoint immutability", () => {
  it("snapshot rows are never updated on a later checkpoint", async () => {
    await commit("a", "one");
    clock.advance();
    const first = await engine.checkpoints.createStateOnly({ projectId, branch: "main" });
    const before = first.snapshot.createdAt;
    clock.advance();
    await engine.checkpoints.createStateOnly({ projectId, branch: "main" });
    const again = await findSnapshotByHash(db as Database, projectId, first.snapshot.snapshotHash);
    expect(again?.createdAt).toBe(before);
  });
});
