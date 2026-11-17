import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChronosError,
  type Clock,
  createIdGenerator,
  type IdGenerator,
  type SourceSurface,
} from "@chronos-ctx/shared-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../db/client.js";
import { migrate } from "../db/migrate.js";
import { type Engine, openEngine } from "../engine.js";
import { getHead } from "../repositories/nodes.js";
import { insertVerificationEvent } from "../repositories/verification.js";

class TestClock implements Clock {
  public t = Date.UTC(2026, 0, 1);

  public now(): number {
    return this.t;
  }
}

let dir: string | undefined;
let db: Database | undefined;
let engine: Engine;
let ids: IdGenerator;
let projectId: string;
let clock: TestClock;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "chronos-epistemic-"));
  db = await openDatabase({ file: join(dir, "chronos.db") });
  await migrate(db);
  clock = new TestClock();
  ids = createIdGenerator({ clock, deterministic: true });
  engine = await openEngine({ database: db, clock, ids, migrate: false });
  projectId = (await engine.projects.create({ slug: "toy-api", name: "Toy API" })).project.id;
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

function commit(overrides: Record<string, unknown> = {}) {
  return engine.commit.commit({
    projectId,
    branch: "main",
    path: "db/schema",
    title: "Schema",
    summary: "Tables",
    content: "users",
    sourceSurface: "opencode-cli",
    ...overrides,
  });
}

describe("web surfaces cannot self-promote (gate 1.3)", () => {
  it("rejects 12/12 attempts across four surfaces and three evidence shapes", async () => {
    const other = await engine.projects.create({ slug: "other", name: "Other" });
    const foreign = await insertVerificationEvent(db as Database, {
      id: ids.id("vev"),
      projectId: other.project.id,
      kind: "test_pass",
      exitCode: 0,
      now: clock.now(),
    });

    const surfaces: SourceSurface[] = ["gemini-web", "chatgpt-web", "claude-web", "qwen-web"];
    let rejected = 0;

    for (const surface of surfaces) {
      const valid = await insertVerificationEvent(db as Database, {
        id: ids.id("vev"),
        projectId,
        kind: "test_pass",
        exitCode: 0,
        now: clock.now(),
      });
      const shapes: Array<Record<string, unknown>> = [
        {},
        { verificationEventId: valid.id },
        { verificationEventId: foreign.id },
      ];
      for (const shape of shapes) {
        const error = await commit({
          sourceSurface: surface,
          requestedStatus: "verified",
          ...shape,
        }).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ChronosError);
        expect((error as ChronosError).code).toBe("EVIDENCE_REQUIRED");
        rejected += 1;
      }
    }

    expect(rejected).toBe(12);
    expect(await getHead(db as Database, projectId, "main", "db/schema")).toBeNull();
  });

  it("still accepts an unverified commit from a web surface", async () => {
    const result = await commit({ sourceSurface: "gemini-web" });
    expect(result.status).toBe("unverified");
  });
});
