import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChronosError,
  type Clock,
  createIdGenerator,
  type IdGenerator,
} from "@chronos-ctx/shared-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../db/client.js";
import { migrate } from "../db/migrate.js";
import { type Engine, openEngine } from "../engine.js";
import { getHead, getNodeView } from "../repositories/nodes.js";
import { insertVerificationEvent } from "../repositories/verification.js";

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
  dir = mkdtempSync(join(tmpdir(), "chronos-commit-"));
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

function commit(overrides: Record<string, unknown> = {}) {
  return engine.commit.commit({
    projectId,
    branch: "main",
    path: "db/schema",
    title: "Schema",
    summary: "Tables and indexes",
    content: "users, sessions",
    sourceSurface: "opencode-cli",
    ...overrides,
  });
}

function event(overrides: Record<string, unknown> = {}): Promise<{ id: string }> {
  return insertVerificationEvent(db as Database, {
    id: ids.id("vev"),
    projectId,
    kind: "test_pass",
    command: "pnpm test",
    exitCode: 0,
    coveredPaths: ["src/db/schema.ts"],
    treeHash: "4f2a91c",
    now: clock.now(),
    verifiedBy: "ci:local",
    ...overrides,
  });
}

describe("commit: version allocation (D1)", () => {
  it("creates version 1 and a readable head", async () => {
    const result = await commit();
    expect(result.version).toBe(1);
    expect(result.status).toBe("unverified");
    expect(result.previousVersion).toBeNull();
    expect(result.path).toBe("db/schema");
    expect(result.node.title).toBe("Schema");
  });

  it("allocates the next version and grows the sequence", async () => {
    await commit();
    clock.advance();
    const second = await commit({ content: "users, sessions, refresh_tokens" });
    expect(second.version).toBe(2);
    expect(second.previousVersion).toBe(1);
  });

  it("returns VERSION_CONFLICT and writes nothing when expected_version is wrong", async () => {
    const first = await commit();
    clock.advance();
    const error = await commit({ expectedVersion: 7, content: "different" }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ChronosError);
    expect((error as ChronosError).code).toBe("VERSION_CONFLICT");
    expect((error as ChronosError).details).toMatchObject({
      path: "db/schema",
      current_version: 1,
      current_version_id: first.versionId,
    });
    expect((error as ChronosError).details?.current_content_hash).toMatch(/^[0-9a-f]{64}$/u);

    const head = await getHead(db as Database, projectId, "main", "db/schema");
    expect(head?.version).toBe(1);
    const view = await getNodeView(db as Database, projectId, "main", "db/schema");
    expect(view?.content).toBe("users, sessions");
  });

  it("rejects an unknown branch", async () => {
    await expect(commit({ branch: "nope" })).rejects.toMatchObject({ code: "BRANCH_NOT_FOUND" });
  });
});

describe("commit: epistemic gate", () => {
  it("refuses verified without evidence", async () => {
    await expect(commit({ requestedStatus: "verified" })).rejects.toMatchObject({
      code: "EVIDENCE_REQUIRED",
    });
  });

  it("refuses verified from a web surface even with a forged event id", async () => {
    const ev = await event();
    await expect(
      commit({
        requestedStatus: "verified",
        verificationEventId: ev.id,
        sourceSurface: "claude-web",
      }),
    ).rejects.toMatchObject({ code: "EVIDENCE_REQUIRED" });
  });

  it("promotes with real evidence and stores the event id and tree", async () => {
    const ev = await event();
    const result = await commit({ requestedStatus: "verified", verificationEventId: ev.id });
    expect(result.status).toBe("verified");
    expect(result.verificationEventId).toBe(ev.id);
    expect(result.node.verificationEventId).toBe(ev.id);
    expect(result.node.verifiedTreeHash).toBe("4f2a91c");
  });

  it("refuses a verification event with a non-zero exit code", async () => {
    const ev = await event({ exitCode: 1 });
    await expect(
      commit({ requestedStatus: "verified", verificationEventId: ev.id }),
    ).rejects.toMatchObject({ code: "EVIDENCE_REQUIRED" });
  });

  it("refuses a non-promoting verification kind", async () => {
    const ev = await event({ kind: "lint_pass" });
    await expect(
      commit({ requestedStatus: "verified", verificationEventId: ev.id }),
    ).rejects.toMatchObject({ code: "EVIDENCE_REQUIRED" });
  });

  it("demotes a verified node when its text changes", async () => {
    const ev = await event();
    await commit({ requestedStatus: "verified", verificationEventId: ev.id });
    clock.advance();
    const changed = await commit({ content: "users, sessions, audit_log" });
    expect(changed.status).toBe("unverified");
    expect(changed.demoted).toBe(true);
  });

  it("demotes on a title-only edit because the title is part of content_hash", async () => {
    const ev = await event();
    await commit({ requestedStatus: "verified", verificationEventId: ev.id });
    clock.advance();
    const changed = await commit({ title: "Schema (renamed)" });
    expect(changed.status).toBe("unverified");
    expect(changed.demoted).toBe(true);
  });

  it("preserves verified only for an identical-text re-commit, carrying the evidence", async () => {
    const ev = await event();
    await commit({ requestedStatus: "verified", verificationEventId: ev.id });
    clock.advance();
    const again = await commit();
    expect(again.status).toBe("verified");
    expect(again.version).toBe(2);
    expect(again.verificationEventId).toBe(ev.id);
    expect(again.node.verifiedTreeHash).toBe("4f2a91c");
  });

  it("rejects evidence that predates a content change", async () => {
    const ev = await event();
    await commit({ requestedStatus: "verified", verificationEventId: ev.id });
    clock.advance();
    await expect(
      commit({
        content: "new content",
        requestedStatus: "verified",
        verificationEventId: ev.id,
      }),
    ).rejects.toMatchObject({ code: "EVIDENCE_STALE" });
  });

  it("accepts fresh evidence for the changed content", async () => {
    const first = await event();
    await commit({ requestedStatus: "verified", verificationEventId: first.id });
    clock.advance();
    const second = await event({ treeHash: "9c31b7e" });
    const result = await commit({
      content: "new content",
      requestedStatus: "verified",
      verificationEventId: second.id,
    });
    expect(result.status).toBe("verified");
    expect(result.node.verifiedTreeHash).toBe("9c31b7e");
  });

  it("does not let an agent override a stale-evidence refusal on a web surface", async () => {
    const ev = await event();
    await commit({ requestedStatus: "verified", verificationEventId: ev.id });
    clock.advance();
    await expect(
      commit({
        sourceSurface: "qwen-web",
        requestedStatus: "verified",
        verificationEventId: ev.id,
        allowAgentOverride: true,
      }),
    ).rejects.toMatchObject({ code: "EVIDENCE_REQUIRED" });
  });
});

describe("commit: validation", () => {
  it("rejects an invalid path before opening a transaction", async () => {
    await expect(commit({ path: "../etc/passwd" })).rejects.toBeInstanceOf(ChronosError);
  });

  it("rejects an empty title", async () => {
    await expect(commit({ title: "  " })).rejects.toMatchObject({ code: "NODE_INVALID" });
  });

  it("rejects content over the hard character cap", async () => {
    await expect(commit({ content: "a".repeat(200_001) })).rejects.toMatchObject({
      code: "NODE_OVERSIZED",
    });
  });

  it("warns when a node exceeds the token hard cap but keeps the write", async () => {
    const result = await commit({ content: "a".repeat(4000) });
    expect(result.warnings.some((warning) => warning.code === "NODE_OVERSIZED")).toBe(true);
  });
});

describe("commit: rename and aliases", () => {
  it("renames a node, writes an alias and keeps lineage", async () => {
    const first = await commit();
    clock.advance();
    const renamed = await commit({
      path: "db/schema-v2",
      fromPath: "db/schema",
    });
    expect(renamed.renamedFrom).toBe("db/schema");
    expect(renamed.version).toBe(2);
    expect(renamed.node.supersedesVersionId).toBe(first.versionId);
    expect(await getHead(db as Database, projectId, "main", "db/schema")).toBeNull();
    expect(await getHead(db as Database, projectId, "main", "db/schema-v2")).not.toBeNull();
  });

  it("refuses to write to a renamed (old) path", async () => {
    await commit();
    clock.advance();
    await commit({ path: "db/schema-v2", fromPath: "db/schema" });
    clock.advance();
    await expect(commit({ content: "stale write" })).rejects.toMatchObject({
      code: "ALIAS_REDIRECT",
    });
  });

  it("refuses to rename a node that does not exist", async () => {
    await expect(commit({ path: "db/new", fromPath: "db/missing" })).rejects.toMatchObject({
      code: "NODE_NOT_FOUND",
    });
  });

  it("refuses to rename onto an existing node", async () => {
    await commit();
    await commit({ path: "db/other", title: "Other" });
    clock.advance();
    await expect(commit({ path: "db/other", fromPath: "db/schema" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});
