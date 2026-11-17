import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChronosError } from "@chronos-ctx/shared-types";
import { afterEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "./client.js";
import { currentVersion, latestVersion, migrate } from "./migrate.js";

const EXPECTED_TABLES = [
  "projects",
  "branches",
  "node_versions",
  "state_nodes",
  "snapshots",
  "checkpoints",
  "negative_constraints",
  "verification_events",
  "node_aliases",
  "rewinds",
  "paging_events",
  "node_edges",
  "agent_sessions",
  "side_effects",
  "nodes_fts",
  "captures",
  "proposals",
  "sync_outbox",
  "devices",
];

let dir: string | undefined;
let db: Database | undefined;

async function freshDatabase(): Promise<Database> {
  dir = mkdtempSync(join(tmpdir(), "chronos-db-"));
  const opened = await openDatabase({ file: join(dir, "chronos.db") });
  db = opened;
  return opened;
}

afterEach(() => {
  db?.close();
  db = undefined;
  if (dir) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      // Windows can hold a WAL handle briefly; a leaked temp dir is not a test failure.
    }
  }
  dir = undefined;
});

describe("pragmas", () => {
  it("sets WAL, foreign keys and a busy timeout", async () => {
    const opened = await freshDatabase();
    const health = await opened.health();
    expect(health.journalMode).toBe("wal");
    expect(health.foreignKeys).toBe(true);
    expect(health.busyTimeoutMs).toBe(5000);
    expect(health.userVersion).toBe(0);
  });

  it("keeps pragmas across concurrent callers because access is serialised", async () => {
    const opened = await freshDatabase();
    await Promise.all([opened.execute("SELECT 1"), opened.execute("SELECT 2"), opened.health()]);
    const health = await opened.health();
    expect(health.foreignKeys).toBe(true);
    expect(health.busyTimeoutMs).toBe(5000);
  });
});

describe("migrate", () => {
  it("creates every normative table from an empty database", async () => {
    const opened = await freshDatabase();
    const result = await migrate(opened);
    expect(result.from).toBe(0);
    expect(result.to).toBe(latestVersion());

    const objects = await opened.execute(
      "SELECT name, type FROM sqlite_master WHERE type IN ('table','view')",
    );
    const names = new Set(objects.rows.map((row) => String(row.name)));
    for (const table of EXPECTED_TABLES) expect(names.has(table)).toBe(true);
    expect(names.has("state_nodes_full")).toBe(true);
  });

  it("is idempotent", async () => {
    const opened = await freshDatabase();
    await migrate(opened);
    const second = await migrate(opened);
    expect(second.applied).toEqual([]);
    expect(second.pending).toEqual([]);
    expect(await currentVersion(opened)).toBe(latestVersion());
  });

  it("reports pending work in dry-run mode without touching the schema", async () => {
    const opened = await freshDatabase();
    const plan = await migrate(opened, { dryRun: true });
    expect(plan.pending.length).toBeGreaterThan(0);
    expect(plan.applied).toEqual([]);
    expect(await currentVersion(opened)).toBe(0);
    const objects = await opened.execute("SELECT name FROM sqlite_master WHERE type='table'");
    expect(objects.rows).toHaveLength(0);
  });

  it("refuses a downgrade and an unknown level", async () => {
    const opened = await freshDatabase();
    await migrate(opened);
    await expect(migrate(opened, { to: 0 })).rejects.toBeInstanceOf(ChronosError);
    await expect(migrate(opened, { to: 99 })).rejects.toBeInstanceOf(ChronosError);
  });

  it("enforces STRICT typing", async () => {
    const opened = await freshDatabase();
    await migrate(opened);
    await expect(
      opened.execute({
        sql: "INSERT INTO projects (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        args: ["prj_x", "x", "X", "not-an-integer", 0],
      }),
    ).rejects.toThrow();
  });

  it("enforces foreign keys", async () => {
    const opened = await freshDatabase();
    await migrate(opened);
    await expect(
      opened.execute({
        sql: "INSERT INTO branches (id, project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        args: ["brn_x", "prj_missing", "main", 0, 0],
      }),
    ).rejects.toThrow(/FOREIGN KEY/iu);
  });

  it("rolls a transaction back when the body throws", async () => {
    const opened = await freshDatabase();
    await migrate(opened);
    await expect(
      opened.withTx(async (tx) => {
        await tx.execute({
          sql: "INSERT INTO projects (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
          args: ["prj_rollback", "rollback", "Rollback", 0, 0],
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const rows = await opened.execute("SELECT count(*) AS n FROM projects");
    expect(Number(rows.rows[0]?.n)).toBe(0);
  });
});
