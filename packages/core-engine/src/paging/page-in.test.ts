import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Clock, createIdGenerator } from "@chronos-ctx/shared-types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../db/client.js";
import { migrate } from "../db/migrate.js";
import { type Engine, openEngine } from "../engine.js";
import { createEdge } from "../repositories/edges.js";
import { PageInService } from "./page-in.js";
import { type PagingFixture, seedPagingFixture } from "./paging.fixture.js";

const DAEMON = { version: "test", pid: 1 };

class FixedClock implements Clock {
  public t = Date.UTC(2026, 6, 1);

  public now(): number {
    this.t += 10;
    return this.t;
  }
}

interface SmallFixture {
  engine: Engine;
  db: Database;
  projectId: string;
  versionOne: string;
  cleanup: () => void;
}

async function seedSmall(): Promise<SmallFixture> {
  const dir = mkdtempSync(join(tmpdir(), "chronos-pagein-"));
  const db = await openDatabase({ file: join(dir, "chronos.db") });
  await migrate(db);
  const clock = new FixedClock();
  const ids = createIdGenerator({ clock, deterministic: true });
  const engine = await openEngine({ database: db, clock, ids, migrate: false });
  const project = await engine.projects.create({ slug: "small", name: "Small" });

  const first = await engine.commit.commit({
    projectId: project.project.id,
    branch: "main",
    path: "b/two",
    title: "Two",
    summary: "Version one",
    content: "first content",
    sourceSurface: "opencode-cli",
  });
  await engine.commit.commit({
    projectId: project.project.id,
    branch: "main",
    path: "b/two",
    title: "Two",
    summary: "Version two",
    content: "second content",
    sourceSurface: "opencode-cli",
  });
  await engine.commit.commit({
    projectId: project.project.id,
    branch: "main",
    path: "a/one",
    title: "One",
    summary: "First node",
    content: "one content",
    sourceSurface: "opencode-cli",
  });
  await engine.commit.commit({
    projectId: project.project.id,
    branch: "main",
    path: "a/renamed",
    title: "Renamed",
    summary: "Renamed node",
    content: "renamed content",
    sourceSurface: "opencode-cli",
    fromPath: "a/one",
  });

  await db.execute({
    sql: `INSERT INTO negative_constraints
            (id, project_id, branch, node_path, failed_approach, failure_reason,
             evidence_kind, severity, dedupe_key, occurrences, status, created_at, updated_at)
          VALUES (?, ?, NULL, ?, ?, ?, 'test_failure', 'blocking', ?, 3, 'active', ?, ?)`,
    args: [
      ids.id("nc"),
      project.project.id,
      "b/two",
      "Do not use the legacy token format",
      "it fails on the Edge runtime",
      "dedupe-small",
      clock.now(),
      clock.now(),
    ],
  });

  await createEdge(db, {
    id: ids.id("edg"),
    projectId: project.project.id,
    fromPath: "b/two",
    toPath: "a/renamed",
    rel: "depends_on",
    now: clock.now(),
  });

  return {
    engine,
    db,
    projectId: project.project.id,
    versionOne: first.versionId,
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

let fixture: PagingFixture;
let small: SmallFixture;

beforeAll(async () => {
  fixture = await seedPagingFixture();
  small = await seedSmall();
}, 180_000);

afterAll(() => {
  fixture.cleanup();
  small.cleanup();
});

function pager(db: Database = fixture.db): PageInService {
  return new PageInService({ db });
}

const twelve = Array.from({ length: 12 }, (_, i) => `auth/auth-${String(i).padStart(2, "0")}`);

describe("page-in budget (gate 1.5)", () => {
  it("pages 12 paths within max_tokens=1200 and counts the envelope", async () => {
    const result = await pager().pageIn({
      projectId: fixture.projectId,
      paths: twelve,
      maxTokens: 1200,
      daemon: DAEMON,
    });

    expect(result.nodes).toHaveLength(12);
    expect(result.nodes.map((node) => node.path)).toEqual(twelve);
    expect(result.total_tokens).toBeLessThanOrEqual(1200);
    expect(result.envelope.tokens.total).toBe(result.total_tokens);
    expect(
      result.envelope.tokens.content +
        result.envelope.tokens.envelope +
        result.envelope.tokens.schema,
    ).toBe(result.total_tokens);
    expect(result.envelope.schema_version).toBe(1);
    expect(result.estimator).toBe("chars4");
    for (const node of result.nodes) {
      expect(node.tokens.total).toBeGreaterThan(0);
      expect(node.version).toBe(1);
      expect(node.status).toBe("verified");
    }
  });

  it("truncates deterministically and reports what was lost", async () => {
    const result = await pager().pageIn({
      projectId: fixture.projectId,
      paths: twelve,
      maxTokens: 300,
      daemon: DAEMON,
    });
    expect(result.total_tokens).toBeLessThanOrEqual(300);
    expect(result.truncated).toBe(true);
    expect(result.warnings.some((warning) => warning.code === "TRUNCATED")).toBe(true);
    expect(result.nodes.length).toBeLessThan(12);
    expect(result.nodes.length).toBeGreaterThan(0);
  });

  it("is deterministic for the same request", async () => {
    const first = await pager().pageIn({
      projectId: fixture.projectId,
      paths: twelve.slice(0, 3),
      daemon: DAEMON,
    });
    const second = await pager().pageIn({
      projectId: fixture.projectId,
      paths: twelve.slice(0, 3),
      daemon: DAEMON,
    });
    expect(first.nodes).toEqual(second.nodes);
    expect(first.total_tokens).toBe(second.total_tokens);
    expect(first.envelope).toEqual(second.envelope);
  });

  it("reports missing paths with suggestions", async () => {
    const result = await pager().pageIn({
      projectId: fixture.projectId,
      paths: ["auth"],
      daemon: DAEMON,
    });
    expect(result.nodes).toHaveLength(0);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]?.suggestions.length).toBeGreaterThan(0);
  });

  it("rejects invalid paths and more than twelve", async () => {
    await expect(
      pager().pageIn({ projectId: fixture.projectId, paths: ["../etc/passwd"], daemon: DAEMON }),
    ).rejects.toMatchObject({ code: "PATH_INVALID" });

    await expect(
      pager().pageIn({
        projectId: fixture.projectId,
        paths: Array.from({ length: 13 }, (_, i) => `auth/x${i}`),
        daemon: DAEMON,
      }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });
});

describe("freshness markers", () => {
  const evidence = new Map([["src/auth.ts", "hash-a"]]);

  it("is fresh when no covered path changed", async () => {
    const result = await pager().pageIn({
      projectId: fixture.projectId,
      paths: ["auth/auth-00"],
      daemon: DAEMON,
      freshness: {
        currentTree: new Map([
          ["src/auth.ts", "hash-a"],
          ["docs/x.md", "changed"],
        ]),
        evidenceTrees: new Map([["tree-fixture", evidence]]),
      },
    });
    expect(result.nodes[0]?.freshness).toBe("fresh");
  });

  it("is stale when a covered path changed", async () => {
    const result = await pager().pageIn({
      projectId: fixture.projectId,
      paths: ["auth/auth-00"],
      daemon: DAEMON,
      freshness: {
        currentTree: new Map([["src/auth.ts", "hash-b"]]),
        evidenceTrees: new Map([["tree-fixture", evidence]]),
      },
    });
    expect(result.nodes[0]?.freshness).toBe("stale");
    expect(result.warnings.some((warning) => warning.code === "STALE_EVIDENCE")).toBe(true);
  });

  it("is unknown without a workspace or an evidence tree", async () => {
    const noWorkspace = await pager().pageIn({
      projectId: fixture.projectId,
      paths: ["auth/auth-00"],
      daemon: DAEMON,
    });
    expect(noWorkspace.nodes[0]?.freshness).toBe("unknown");

    const noEvidence = await pager().pageIn({
      projectId: fixture.projectId,
      paths: ["auth/auth-00"],
      daemon: DAEMON,
      freshness: { currentTree: new Map([["src/auth.ts", "hash-a"]]), evidenceTrees: new Map() },
    });
    expect(noEvidence.nodes[0]?.freshness).toBe("unknown");
  });
});

describe("aliases, pinning, constraints and edges", () => {
  it("follows an alias and warns about the redirect", async () => {
    const result = await pager(small.db).pageIn({
      projectId: small.projectId,
      paths: ["a/one"],
      daemon: DAEMON,
    });
    expect(result.nodes[0]?.path).toBe("a/renamed");
    expect(result.nodes[0]?.resolved_from).toBe("a/one");
    expect(result.warnings.some((warning) => warning.code === "ALIAS_REDIRECT")).toBe(true);
  });

  it("resolves a pinned version instead of the head", async () => {
    const result = await pager(small.db).pageIn({
      projectId: small.projectId,
      paths: ["b/two"],
      daemon: DAEMON,
      versionPolicy: "pinned",
      pinnedVersions: { "b/two": small.versionOne },
    });
    expect(result.nodes[0]?.version).toBe(1);
    expect(result.nodes[0]?.content).toBe("first content");
  });

  it("includes negative constraints for the node", async () => {
    const result = await pager(small.db).pageIn({
      projectId: small.projectId,
      paths: ["b/two"],
      daemon: DAEMON,
    });
    const constraints = result.nodes[0]?.negative_constraints ?? [];
    expect(constraints).toHaveLength(1);
    expect(constraints[0]?.severity).toBe("blocking");
    expect(constraints[0]?.occurrences).toBe(3);
  });

  it("expands one hop of edges with summaries", async () => {
    const result = await pager(small.db).pageIn({
      projectId: small.projectId,
      paths: ["b/two"],
      daemon: DAEMON,
      expand: ["depends_on"],
    });
    expect(result.nodes[0]?.edges).toEqual([
      { rel: "depends_on", to_path: "a/renamed", summary: "Renamed node" },
    ]);
  });

  it("suggests eviction only for paths no longer referenced", async () => {
    const result = await pager(small.db).pageIn({
      projectId: small.projectId,
      paths: ["b/two"],
      daemon: DAEMON,
      expand: ["depends_on"],
      suggestEvict: true,
      previouslyPaged: ["b/two", "a/renamed", "z/old"],
    });
    expect(result.evict_candidates).toEqual(["z/old"]);
  });

  it("rejects self-edges, unknown relations and invalid edge paths", async () => {
    const base = {
      projectId: small.projectId,
      now: 1,
    };
    await expect(
      createEdge(small.db, {
        ...base,
        id: "edg_self",
        fromPath: "b/two",
        toPath: "b/two",
        rel: "depends_on",
      }),
    ).rejects.toMatchObject({ code: "NODE_INVALID" });

    await expect(
      createEdge(small.db, {
        ...base,
        id: "edg_rel",
        fromPath: "b/two",
        toPath: "a/renamed",
        rel: "nope" as never,
      }),
    ).rejects.toMatchObject({ code: "NODE_INVALID" });

    await expect(
      createEdge(small.db, {
        ...base,
        id: "edg_path",
        fromPath: "../escape",
        toPath: "a/renamed",
        rel: "depends_on",
      }),
    ).rejects.toMatchObject({ code: "PATH_INVALID" });
  });

  it("caps expansion at three relations", async () => {
    await expect(
      pager(small.db).pageIn({
        projectId: small.projectId,
        paths: ["b/two"],
        daemon: DAEMON,
        expand: ["depends_on", "implements", "tests", "documents"],
      }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });
});
