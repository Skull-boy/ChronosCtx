import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "./client.js";
import { migrate } from "./migrate.js";
import { TABLES } from "./schema.js";

/**
 * Gate 1.1: the Drizzle mirror and the normative DDL describe one schema.
 * Drift in either direction fails here rather than in production.
 */

const TYPE_FOR_COLUMN: Record<string, string> = {
  SQLiteText: "TEXT",
  SQLiteInteger: "INTEGER",
  SQLiteReal: "REAL",
  SQLiteBlob: "BLOB",
  SQLiteBlobBuffer: "BLOB",
};

let dir: string;
let db: Database;

interface PragmaColumn {
  name: string;
  type: string;
  notnull: number;
  pk: number;
  dflt_value: string | null;
}

async function tableInfo(table: string): Promise<PragmaColumn[]> {
  const result = await db.execute(`PRAGMA table_info(${table})`);
  return result.rows.map((row) => ({
    name: String(row.name),
    type: String(row.type).toUpperCase(),
    notnull: Number(row.notnull),
    pk: Number(row.pk),
    dflt_value: row.dflt_value === null ? null : String(row.dflt_value),
  }));
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "chronos-parity-"));
  db = await openDatabase({ file: join(dir, "chronos.db") });
  await migrate(db);
});

afterAll(() => {
  db?.close();
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // Best-effort temp cleanup.
  }
});

describe("schema parity", () => {
  it("covers every DDL table and no phantom tables", async () => {
    const result = await db.execute(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const ddlTables = result.rows
      .map((row) => String(row.name))
      .filter(
        (name) =>
          !name.startsWith("sqlite_") && !name.startsWith("nodes_fts_") && name !== "nodes_fts",
      );
    expect([...ddlTables].sort()).toEqual([...Object.keys(TABLES)].sort());
  });

  it("models the FTS5 table explicitly as excluded", async () => {
    const result = await db.execute(
      "SELECT name FROM sqlite_master WHERE name='nodes_fts' AND type='table'",
    );
    expect(result.rows).toHaveLength(1);
    expect(Object.hasOwn(TABLES, "nodes_fts")).toBe(false);
  });

  it.each(Object.entries(TABLES))(
    "%s: column names, types and nullability match",
    async (name, table) => {
      const pragma = await tableInfo(name);
      const config = getTableConfig(table);
      const drizzle = new Map(config.columns.map((column) => [column.name, column]));
      const compositePk = new Set<string>(
        config.primaryKeys.flatMap((key) => key.columns.map((column) => column.name)),
      );

      expect([...drizzle.keys()].sort()).toEqual(pragma.map((column) => column.name).sort());

      for (const column of pragma) {
        const mirror = drizzle.get(column.name);
        expect(mirror, `${name}.${column.name} missing from Drizzle`).toBeDefined();
        if (mirror === undefined) continue;

        const expectedType = TYPE_FOR_COLUMN[mirror.columnType];
        expect(expectedType, `unmapped Drizzle column type ${mirror.columnType}`).toBeDefined();
        expect(column.type, `${name}.${column.name} type`).toBe(expectedType);

        const isPrimary = mirror.primary || compositePk.has(column.name);
        expect(column.pk > 0, `${name}.${column.name} primary key`).toBe(isPrimary);
        if (column.pk === 0) {
          expect(column.notnull === 1, `${name}.${column.name} nullability`).toBe(mirror.notNull);
        }
        expect(column.dflt_value === null, `${name}.${column.name} default presence`).toBe(
          mirror.default === undefined,
        );
      }
    },
  );
});
