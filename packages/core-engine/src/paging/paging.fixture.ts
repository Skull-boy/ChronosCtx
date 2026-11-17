import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Clock, createIdGenerator } from "@chronos-ctx/shared-types";
import { type Database, openDatabase } from "../db/client.js";
import { migrate } from "../db/migrate.js";
import { type Engine, openEngine } from "../engine.js";
import { insertVerificationEvent } from "../repositories/verification.js";

/**
 * Deterministic 300-node fixture used by the pager gates. Not shipped: the
 * tsconfig excludes `*.fixture.ts` from the package build.
 */

class FixedClock implements Clock {
  public t = Date.UTC(2026, 5, 1);

  public now(): number {
    this.t += 10;
    return this.t;
  }
}

const GROUPS: Array<{ prefix: string; count: number }> = [
  { prefix: "auth", count: 50 },
  { prefix: "api", count: 60 },
  { prefix: "db", count: 40 },
  { prefix: "tasks", count: 50 },
  { prefix: "docs", count: 60 },
  { prefix: "tests", count: 40 },
];

export interface PagingFixture {
  engine: Engine;
  db: Database;
  dir: string;
  projectId: string;
  branch: string;
  checkpointId: string;
  verified: number;
  cleanup: () => void;
}

export async function seedPagingFixture(
  options: { verified?: number; checkpoint?: boolean } = {},
): Promise<PagingFixture> {
  const dir = mkdtempSync(join(tmpdir(), "chronos-paging-"));
  const db = await openDatabase({ file: join(dir, "chronos.db") });
  await migrate(db);

  const clock = new FixedClock();
  const ids = createIdGenerator({ clock, deterministic: true });
  const engine = await openEngine({ database: db, clock, ids, migrate: false });
  const created = await engine.projects.create({
    slug: "paging-fixture",
    name: "Paging Fixture",
    activeObjective: "Keep the boot index under 150 tokens at 300 nodes.",
  });

  const wantedVerified = options.verified ?? 42;
  let index = 0;

  for (const group of GROUPS) {
    for (let i = 0; i < group.count; i += 1) {
      const path = `${group.prefix}/${group.prefix}-${String(i).padStart(2, "0")}`;
      const content = `${group.prefix} node ${i}: deterministic fixture content for paging tests.`;
      const verified = index < wantedVerified;
      let verificationEventId: string | null = null;

      if (verified) {
        const event = await insertVerificationEvent(db, {
          id: ids.id("vev"),
          projectId: created.project.id,
          kind: "test_pass",
          command: "pnpm test",
          exitCode: 0,
          coveredPaths: [`src/${group.prefix}.ts`],
          treeHash: "tree-fixture",
          now: clock.now(),
          verifiedBy: "ci:fixture",
        });
        verificationEventId = event.id;
      }

      await engine.commit.commit({
        projectId: created.project.id,
        branch: "main",
        path,
        title: `${group.prefix} ${i}`,
        summary: `Fixture ${group.prefix} ${i} summary.`,
        content,
        sourceSurface: "opencode-cli",
        ...(verificationEventId === null
          ? {}
          : { requestedStatus: "verified" as const, verificationEventId }),
      });
      index += 1;
    }
  }

  let checkpointId = "";
  if (options.checkpoint !== false) {
    const checkpoint = await engine.checkpoints.createStateOnly({
      projectId: created.project.id,
      branch: "main",
      message: "fixture baseline",
    });
    checkpointId = checkpoint.checkpoint.checkpointId;
  }

  return {
    engine,
    db,
    dir,
    projectId: created.project.id,
    branch: "main",
    checkpointId,
    verified: Math.min(wantedVerified, index),
    cleanup: () => {
      engine.close();
      db.close();
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      } catch {
        // Windows can hold a WAL handle briefly.
      }
    },
  };
}
