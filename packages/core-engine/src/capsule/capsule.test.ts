import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Clock, createIdGenerator } from "@chronos-ctx/shared-types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderHash } from "../content/hash.js";
import { type Database, openDatabase } from "../db/client.js";
import { migrate } from "../db/migrate.js";
import { type Engine, openEngine } from "../engine.js";
import { insertVerificationEvent } from "../repositories/verification.js";
import { CapsuleService } from "./export.js";
import { parseCapsule } from "./parse.js";
import { findVolatileFields, verifyCapsuleDocument, verifyCapsuleText } from "./verify.js";

class FixedClock implements Clock {
  public t = Date.UTC(2026, 7, 1);

  public now(): number {
    this.t += 10;
    return this.t;
  }
}

interface Fixture {
  engine: Engine;
  db: Database;
  dir: string;
  projectId: string;
  checkpointId: string;
  emptyProjectId: string;
  cleanup: () => void;
}

async function seed(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "chronos-capsule-"));
  const db = await openDatabase({ file: join(dir, "chronos.db") });
  await migrate(db);
  const clock = new FixedClock();
  const ids = createIdGenerator({ clock, deterministic: true });
  const engine = await openEngine({ database: db, clock, ids, migrate: false });

  const created = await engine.projects.create({
    slug: "capsule-fixture",
    name: "Capsule Fixture",
    activeObjective: "Ship rotation without breaking the Edge build.",
  });

  const event = await insertVerificationEvent(db, {
    id: ids.id("vev"),
    projectId: created.project.id,
    kind: "test_pass",
    command: "pnpm test",
    exitCode: 0,
    coveredPaths: ["src/auth.ts"],
    treeHash: "tree-a",
    now: clock.now(),
    verifiedBy: "ci:fixture",
  });

  await engine.commit.commit({
    projectId: created.project.id,
    branch: "main",
    path: "auth/jwt-spec",
    title: "JWT spec",
    summary: "RS256, 15m access / 7d refresh",
    content: "Access tokens are RS256 and short lived.",
    sourceSurface: "opencode-cli",
    requestedStatus: "verified",
    verificationEventId: event.id,
  });
  await engine.commit.commit({
    projectId: created.project.id,
    branch: "main",
    path: "auth/rotation-flow",
    title: "Rotation flow",
    summary: "Draft sequence, not yet tested",
    content: "Draft rotation sequence.",
    sourceSurface: "opencode-cli",
  });
  await engine.commit.commit({
    projectId: created.project.id,
    branch: "main",
    path: "auth/legacy",
    title: "Legacy tokens",
    summary: "Retired format",
    content: "Retired.",
    sourceSurface: "opencode-cli",
    requestedStatus: "deprecated",
  });

  await db.execute({
    sql: `INSERT INTO negative_constraints
            (id, project_id, branch, node_path, failed_approach, failure_reason,
             evidence_kind, severity, dedupe_key, occurrences, status, created_at, updated_at)
          VALUES (?, ?, 'main', ?, ?, ?, 'agent_reported', 'blocking', ?, 2, 'active', ?, ?)`,
    args: [
      ids.id("nc"),
      created.project.id,
      "auth/rotation-flow",
      "jose@4 in Edge runtime",
      "crypto.subtle import fails",
      "dedupe-capsule",
      clock.now(),
      clock.now(),
    ],
  });

  await db.execute({
    sql: `INSERT INTO side_effects
            (id, project_id, branch, checkpoint_id, kind, description, command,
             reversible, undo_hint, reported_by, created_at)
          VALUES (?, ?, 'main', NULL, 'package_install', ?, ?, 0, NULL, 'agent', ?)`,
    args: [
      ids.id("sfe"),
      created.project.id,
      "pnpm add prisma@6",
      "pnpm add prisma@6",
      clock.now(),
    ],
  });

  const checkpoint = await engine.checkpoints.createStateOnly({
    projectId: created.project.id,
    branch: "main",
    message: "capsule baseline",
  });

  const empty = await engine.projects.create({ slug: "no-checkpoint", name: "No Checkpoint" });

  return {
    engine,
    db,
    dir,
    projectId: created.project.id,
    checkpointId: checkpoint.checkpoint.checkpointId,
    emptyProjectId: empty.project.id,
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

let fixture: Fixture;
let service: CapsuleService;

const STALE = {
  currentTree: new Map([["src/auth.ts", "hash-2"]]),
  evidenceTrees: new Map([["tree-a", new Map([["src/auth.ts", "hash-1"]])]]),
};

beforeAll(async () => {
  fixture = await seed();
  service = new CapsuleService({ db: fixture.db });
}, 120_000);

afterAll(() => {
  fixture.cleanup();
});

describe("capsule export", () => {
  it("renders from the checkpoint snapshot with both identities", async () => {
    const result = await service.export({
      projectId: fixture.projectId,
      checkpointId: fixture.checkpointId,
      freshness: STALE,
    });

    expect(result.capsule.head_checkpoint_id).toBe(fixture.checkpointId);
    expect(result.capsule.branch).toBe("main");
    expect(result.capsule.snapshot_hash).toMatch(/^sha256:/);
    expect(result.capsule.content_root).toMatch(/^sha256:/);
    expect(result.capsule.tree_hash).toBeNull();
    expect(result.capsule.protocol).toBe("capsule-v1");
    expect(result.capsule.budgets.hard).toBe(500);
    expect(result.tokens).toBeLessThanOrEqual(500);

    expect(result.text).toContain("CHRONOS CAPSULE v1");
    expect(result.text).toContain(`head: ${fixture.checkpointId}   tree: none`);
    expect(result.text).toContain(`snapshot: ${result.capsule.snapshot_hash}`);
    expect(result.text).toContain("objective: Ship rotation without breaking the Edge build.");
    expect(result.text).toContain("VERIFIED (trust):");
    expect(result.text).toContain("HYPOTHESES (validate before use):");
    expect(result.text).toContain("DO NOT RETRY (caution unless promoted):");
    expect(result.text).toContain("SIDE EFFECTS IN RANGE:");
    expect(result.text).toContain("RESUME PROTOCOL:");
  });

  it("marks stale and unverified nodes and excludes deprecated ones", async () => {
    const result = await service.export({
      projectId: fixture.projectId,
      checkpointId: fixture.checkpointId,
      freshness: STALE,
    });

    expect(result.text).toContain("auth/jwt-spec@v1 [stale: tree changed in 1 covered path]");
    expect(result.text).toContain("auth/rotation-flow@v1 [unverified: node is not verified]");
    expect(result.text).not.toContain("auth/legacy");
    expect(result.capsule.dropped.deprecated).toBe(1);

    const verified = result.capsule.nodes.find((node) => node.path === "auth/jwt-spec");
    expect(verified?.freshness).toBe("stale");
    expect(verified?.status).toBe("verified");
    const unverified = result.capsule.nodes.find((node) => node.path === "auth/rotation-flow");
    expect(unverified?.freshness).toBe("unknown");
  });

  it("includes constraints and side effects in range", async () => {
    const result = await service.export({
      projectId: fixture.projectId,
      checkpointId: fixture.checkpointId,
      freshness: STALE,
    });

    expect(result.text).toContain(
      "jose@4 in Edge runtime → crypto.subtle import fails (agent_reported, blocking)",
    );
    expect(result.text).toContain("package_install: pnpm add prisma@6 (not reversible)");
    expect(result.capsule.constraints).toHaveLength(1);
    expect(result.capsule.constraints[0]?.severity).toBe("blocking");
    expect(result.capsule.side_effects).toHaveLength(1);
    expect(result.capsule.side_effects[0]?.reversible).toBe(false);
  });

  it("is byte-identical for the same snapshot", async () => {
    const first = await service.export({
      projectId: fixture.projectId,
      checkpointId: fixture.checkpointId,
      freshness: STALE,
    });
    const second = await service.export({
      projectId: fixture.projectId,
      checkpointId: fixture.checkpointId,
      freshness: STALE,
    });
    expect(first.text).toBe(second.text);
    expect(first.capsule.render_hash).toBe(second.capsule.render_hash);
    expect(first.capsule.render_hash).toBe(renderHash(first.text));
  });

  it("keeps timestamps, pids and durations out of the visible text", async () => {
    const result = await service.export({
      projectId: fixture.projectId,
      checkpointId: fixture.checkpointId,
      freshness: STALE,
    });
    expect(findVolatileFields(result.text)).toEqual([]);
    expect(result.text).not.toMatch(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u);
  });

  it("reports unknown freshness when no workspace is attached", async () => {
    const result = await service.export({
      projectId: fixture.projectId,
      checkpointId: fixture.checkpointId,
    });
    expect(result.text).toContain("auth/jwt-spec@v1 [unknown: no workspace attached]");
  });

  it("uses the branch head when no checkpoint is named", async () => {
    const result = await service.export({ projectId: fixture.projectId, freshness: STALE });
    expect(result.capsule.head_checkpoint_id).toBe(fixture.checkpointId);
  });

  it("refuses a branch that does not own the checkpoint", async () => {
    await expect(
      service.export({
        projectId: fixture.projectId,
        checkpointId: fixture.checkpointId,
        branch: "other",
      }),
    ).rejects.toMatchObject({ code: "CHECKPOINT_NOT_FOUND" });
  });

  it("refuses a branch with no checkpoint instead of rendering an empty capsule", async () => {
    await expect(service.export({ projectId: fixture.emptyProjectId })).rejects.toMatchObject({
      code: "CHECKPOINT_NOT_FOUND",
    });
  });

  it("reports a missing project", async () => {
    await expect(service.export({ projectId: "prj_missing" })).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
    });
  });

  it("trims under a small budget and reports what it dropped", async () => {
    const result = await service.export({
      projectId: fixture.projectId,
      checkpointId: fixture.checkpointId,
      maxTokens: 150,
      freshness: STALE,
    });
    expect(result.tokens).toBeLessThanOrEqual(150);
    expect(result.text.startsWith("CHRONOS CAPSULE v1")).toBe(true);
    expect(result.text).toContain("RESUME PROTOCOL:");
    if (result.truncated) {
      expect(
        result.capsule.dropped.hypothesis_lines +
          result.capsule.dropped.constraint_lines +
          result.capsule.dropped.constraint_details +
          result.capsule.dropped.side_effect_lines +
          result.capsule.dropped.side_effect_details +
          result.capsule.dropped.verified_summaries +
          result.capsule.dropped.verified_nodes,
      ).toBeGreaterThan(0);
    }
  });
});

describe("capsule verification", () => {
  it("verifies the exported document byte-for-byte", async () => {
    const result = await service.export({
      projectId: fixture.projectId,
      checkpointId: fixture.checkpointId,
      freshness: STALE,
    });
    const document = JSON.stringify({ text: result.text, capsule: result.capsule });
    const verification = verifyCapsuleDocument(document);
    expect(verification.ok).toBe(true);
    expect(verification.computed).toBe(result.capsule.render_hash);
    expect(verification.expected).toBe(result.capsule.render_hash);
  });

  it("refuses a doctored text", async () => {
    const result = await service.export({
      projectId: fixture.projectId,
      checkpointId: fixture.checkpointId,
      freshness: STALE,
    });
    const doctored = result.text.replace("[stale:", "[fresh:");
    const verification = verifyCapsuleText(doctored, result.capsule.render_hash);
    expect(verification.ok).toBe(false);
    expect(verification.reason).toBe("render_hash does not match the text");
  });

  it("recomputes a plain-text capsule and matches the exported hash", async () => {
    const result = await service.export({
      projectId: fixture.projectId,
      checkpointId: fixture.checkpointId,
      freshness: STALE,
    });
    const verification = verifyCapsuleText(result.text);
    expect(verification.ok).toBe(true);
    expect(verification.computed).toBe(result.capsule.render_hash);
    expect(verification.reason).toBe("no render_hash supplied; computed only");
  });

  it("is insensitive to line endings and a trailing newline", async () => {
    const result = await service.export({
      projectId: fixture.projectId,
      checkpointId: fixture.checkpointId,
      freshness: STALE,
    });
    const windows = `${result.text.replace(/\n/gu, "\r\n")}\r\n`;
    expect(verifyCapsuleText(windows).computed).toBe(result.capsule.render_hash);
  });

  it("rejects a malformed capsule", () => {
    expect(() => parseCapsule("not a capsule")).toThrowError(/CHRONOS CAPSULE v1/u);
    expect(() => verifyCapsuleText("not a capsule")).toThrowError(/CAPSULE_INVALID|CHRONOS/u);
  });

  it("rejects a JSON document with no text to verify", () => {
    expect(() => verifyCapsuleDocument(JSON.stringify({ capsule: {} }))).toThrowError(
      /no text field/u,
    );
  });
});
