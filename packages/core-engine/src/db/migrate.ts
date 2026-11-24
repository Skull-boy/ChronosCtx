import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ChronosError } from "@chronos-ctx/shared-types";
import type { Database } from "./client.js";

/**
 * Forward-only migrations (§1.1). `PRAGMA user_version` is the single source of
 * truth; there is no separate bookkeeping table to drift out of sync with it.
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly file: string;
}

export interface MigrationStatus {
  version: number;
  name: string;
}

export interface MigrateOptions {
  dryRun?: boolean;
  to?: number;
}

export interface MigrateResult {
  from: number;
  to: number;
  applied: MigrationStatus[];
  pending: MigrationStatus[];
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "init", file: "0001_init.sql" },
];

/**
 * The source build keeps SQL beside the package (`packages/core-engine/migrations`)
 * while a bundled release keeps it beside the bundle (`<pkg>/migrations`). Both
 * are legitimate, so resolve by probing the known layouts and fail loudly if
 * none contains the first migration. `CHRONOS_MIGRATIONS_DIR` is an explicit
 * escape hatch for unusual packaging.
 */
function resolveMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.CHRONOS_MIGRATIONS_DIR,
    join(here, "..", "..", "migrations"),
    join(here, "..", "migrations"),
    resolve(process.cwd(), "migrations"),
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && existsSync(join(candidate, MIGRATIONS[0]?.file ?? ""))) {
      return candidate;
    }
  }
  throw new ChronosError(
    "INTERNAL",
    "migrations directory not found; the installation is incomplete",
    {
      hint: "Reinstall the package, or set CHRONOS_MIGRATIONS_DIR to the directory containing 0001_init.sql.",
      details: { searched: candidates.filter((value): value is string => value !== undefined) },
    },
  );
}

const MIGRATIONS_DIR = resolveMigrationsDir();

export function latestVersion(): number {
  const last = MIGRATIONS[MIGRATIONS.length - 1];
  return last === undefined ? 0 : last.version;
}

export async function currentVersion(db: Database): Promise<number> {
  const result = await db.execute("PRAGMA user_version");
  return Number(result.rows[0]?.user_version ?? 0);
}

export async function migrate(db: Database, options: MigrateOptions = {}): Promise<MigrateResult> {
  const from = await currentVersion(db);
  const latest = latestVersion();
  const target = options.to ?? latest;

  if (!Number.isInteger(target) || target < 0 || target > latest) {
    throw new ChronosError("UNSUPPORTED", `migration target ${target} does not exist`, {
      hint: `Known migration levels are 0..${latest}.`,
    });
  }
  if (target < from) {
    throw new ChronosError(
      "UNSUPPORTED",
      `refusing to downgrade schema from ${from} to ${target}`,
      {
        hint: "Migrations are forward-only. Restore a backup instead.",
      },
    );
  }

  const pending = MIGRATIONS.filter((m) => m.version > from && m.version <= target);
  const applied: MigrationStatus[] = [];

  if (options.dryRun !== true) {
    for (const migration of pending) {
      const sql = await readFile(join(MIGRATIONS_DIR, migration.file), "utf8");
      try {
        await db.withTx(async (tx) => {
          await tx.executeMultiple(sql);
          await tx.execute(`PRAGMA user_version = ${migration.version}`);
        });
      } catch (error) {
        throw new ChronosError(
          "INTERNAL",
          `migration ${migration.file} failed; schema left at version ${from}`,
          {
            cause: error,
            hint: "Each migration runs in one transaction, so no partial schema is applied.",
          },
        );
      }
      applied.push({ version: migration.version, name: migration.name });
    }
  }

  const to = options.dryRun === true ? from : await currentVersion(db);
  return {
    from,
    to,
    applied,
    pending: pending.map((m) => ({ version: m.version, name: m.name })),
  };
}
