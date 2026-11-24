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
import { insertVerificationEvent, type VerificationKind } from "../repositories/verification.js";
import type { CommitResult } from "../services/commit.js";

/**
 * Gate 1.2 — the epistemic invariant under load.
 *
 * A `verified` head is a claim that a check passed against exactly that
 * content. The invariant under test is not "the gate usually demotes"; it is:
 *
 *   every head whose status is `verified` points at a version that carries a
 *   promoting verification event, with exit code 0 (or null), from the same
 *   project, and a `verified_tree_hash` that equals that event's `tree_hash`.
 *
 * The workload is a deterministic 10,000-operation sequence over three
 * branches and four paths. It mixes legitimate promotions, byte-identical
 * inheritance, stale evidence, failing evidence, non-promoting evidence,
 * missing evidence, web-surface attempts, demotions, deprecations and version
 * conflicts. Because the generator is seeded, a failure is reproducible.
 */

class TestClock implements Clock {
  public t = Date.UTC(2026, 0, 1);

  public now(): number {
    this.t += 1;
    return this.t;
  }
}

/** Deterministic PRNG (mulberry32) so a failing sequence can be replayed. */
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

const PROMOTING_KINDS: readonly VerificationKind[] = [
  "test_pass",
  "build_pass",
  "typecheck_pass",
  "user_approval",
];
const NON_PROMOTING_KINDS: readonly VerificationKind[] = ["lint_pass", "import_trust", "override"];
const WEB_SURFACES: readonly SourceSurface[] = [
  "gemini-web",
  "chatgpt-web",
  "claude-web",
  "qwen-web",
];

let dir: string | undefined;
let db: Database | undefined;
let engine: Engine;
let ids: IdGenerator;
let clock: TestClock;
let projectId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "chronos-invariant-"));
  db = await openDatabase({ file: join(dir, "chronos.db") });
  await migrate(db);
  clock = new TestClock();
  ids = createIdGenerator({ clock, deterministic: true });
  engine = await openEngine({ database: db, clock, ids, migrate: false });
  projectId = (await engine.projects.create({ slug: "toy-api", name: "Toy API" })).project.id;
  await engine.projects.fork(projectId, "side-a");
  await engine.projects.fork(projectId, "side-b");
});

afterEach(() => {
  engine?.close();
  db?.close();
  db = undefined;
  if (dir) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      // Windows can hold a WAL handle briefly after close.
    }
  }
  dir = undefined;
});

async function expectFailure(promise: Promise<unknown>, code: string): Promise<ChronosError> {
  const caught = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(ChronosError);
  expect((caught as ChronosError).code).toBe(code);
  return caught as ChronosError;
}

/** A commit either succeeds or throws; this keeps both branches typed. */
async function settle(
  promise: Promise<CommitResult>,
): Promise<{ ok: true; value: CommitResult } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * The authoritative check. It joins heads to versions and versions to their
 * evidence, so a version that merely *claims* verified without a matching
 * event cannot pass.
 */
async function assertEveryVerifiedHeadIsEvidenced(
  database: Database,
  expectedProjectId: string,
): Promise<number> {
  const heads = await database.execute({
    sql: `SELECT n.branch AS branch,
                 n.path AS path,
                 n.status AS head_status,
                 v.status AS version_status,
                 v.verification_event_id AS event_id,
                 v.verified_tree_hash AS verified_tree_hash,
                 e.id AS found_event_id,
                 e.project_id AS event_project_id,
                 e.kind AS kind,
                 e.exit_code AS exit_code,
                 e.tree_hash AS event_tree_hash
            FROM state_nodes n
            JOIN node_versions v ON v.version_id = n.head_version_id
            LEFT JOIN verification_events e ON e.id = v.verification_event_id
           WHERE n.status = 'verified'`,
    args: [],
  });

  for (const row of heads.rows) {
    const where = `${String(row.branch)}:${String(row.path)}`;
    expect(row.head_status, `head ${where} is not verified`).toBe("verified");
    expect(row.version_status, `version ${where} is not verified`).toBe("verified");
    expect(row.event_id, `verified head ${where} has no verification event id`).not.toBeNull();
    expect(row.found_event_id, `verified head ${where} references a missing event`).toBe(
      row.event_id,
    );
    expect(row.event_project_id, `event for ${where} belongs to another project`).toBe(
      expectedProjectId,
    );
    expect(
      PROMOTING_KINDS.includes(row.kind as VerificationKind),
      `event kind for ${where} cannot promote`,
    ).toBe(true);
    const exitCode = row.exit_code;
    expect(
      exitCode === null || Number(exitCode) === 0,
      `event for ${where} reports exit code ${String(exitCode)}`,
    ).toBe(true);
    expect(row.verified_tree_hash, `tree hash for ${where} is not bound to the event`).toBe(
      row.event_tree_hash,
    );
  }

  // A head and its version must never disagree about status.
  const mismatched = await database.execute(
    `SELECT count(*) AS n
       FROM state_nodes n
       JOIN node_versions v ON v.version_id = n.head_version_id
      WHERE n.status <> v.status`,
  );
  expect(Number(mismatched.rows[0]?.n)).toBe(0);

  // Trust is not carried on a non-verified version.
  const unevidenced = await database.execute(
    `SELECT count(*) AS n
       FROM node_versions
      WHERE status <> 'verified'
        AND (verification_event_id IS NOT NULL OR verified_tree_hash IS NOT NULL)`,
  );
  expect(Number(unevidenced.rows[0]?.n)).toBe(0);

  return heads.rows.length;
}

describe("verified-head invariant (gate 1.2)", () => {
  it("10,000 randomized commit sequences leave zero unevidenced verified heads", async () => {
    const database = db as Database;
    const branches = ["main", "side-a", "side-b"];
    const paths = ["db/schema", "auth/jwt", "api/routes", "tasks/active"];
    const random = mulberry32(20261124);

    // Last successful text and version per (branch, path), used for
    // byte-identical inheritance and expected-version conflicts.
    const lastText = new Map<string, string>();
    const lastSummary = new Map<string, string>();
    const lastVersion = new Map<string, number>();

    const counts = {
      verified: 0,
      unverified: 0,
      deprecated: 0,
      demoted: 0,
      rejected: 0,
      inherited: 0,
      successes: 0,
    };

    for (let i = 0; i < 10_000; i += 1) {
      const branch = branches[Math.floor(random() * branches.length)] ?? "main";
      const path = paths[Math.floor(random() * paths.length)] ?? "db/schema";
      const key = `${branch}:${path}`;
      const content = `revision ${i}`;
      const roll = random();

      let result: CommitResult | null = null;

      if (roll < 0.32) {
        // A plain write. This is the common case and it must demote a
        // previously verified head.
        result = await engine.commit.commit({
          projectId,
          branch,
          path,
          title: path,
          summary: `summary ${i}`,
          content,
          sourceSurface: "opencode-cli",
          author: "agent:test",
        });
        counts.unverified += 1;
      } else if (roll < 0.55) {
        // A legitimate promotion: fresh evidence, promoting kind, exit 0/null.
        const treeHash = random() < 0.5 ? `tree_${i}` : null;
        const event = await insertVerificationEvent(database, {
          id: ids.id("vev"),
          projectId,
          kind: PROMOTING_KINDS[Math.floor(random() * PROMOTING_KINDS.length)] ?? "test_pass",
          exitCode: random() < 0.5 ? 0 : null,
          treeHash,
          now: clock.now(),
        });
        result = await engine.commit.commit({
          projectId,
          branch,
          path,
          title: path,
          summary: `summary ${i}`,
          content,
          sourceSurface: "opencode-cli",
          author: "agent:test",
          requestedStatus: "verified",
          verificationEventId: event.id,
        });
        counts.verified += 1;
      } else if (roll < 0.63) {
        // Evidence older than the previous version: EVIDENCE_STALE when the
        // content changed, legitimate when the path is new or unchanged.
        const event = await insertVerificationEvent(database, {
          id: ids.id("vev"),
          projectId,
          kind: "test_pass",
          exitCode: 0,
          treeHash: `tree_stale_${i}`,
          now: 0,
        });
        const caught = await settle(
          engine.commit.commit({
            projectId,
            branch,
            path,
            title: path,
            summary: `summary ${i}`,
            content,
            sourceSurface: "opencode-cli",
            author: "agent:test",
            requestedStatus: "verified",
            verificationEventId: event.id,
          }),
        );
        if (!caught.ok) {
          expect(caught.error).toBeInstanceOf(ChronosError);
          expect((caught.error as ChronosError).code).toBe("EVIDENCE_STALE");
          counts.rejected += 1;
        } else {
          expect(caught.value.status).toBe("verified");
          result = caught.value;
          counts.verified += 1;
        }
      } else if (roll < 0.7) {
        // Failing evidence can never promote.
        const event = await insertVerificationEvent(database, {
          id: ids.id("vev"),
          projectId,
          kind: "test_pass",
          exitCode: 1,
          now: clock.now(),
        });
        await expectFailure(
          engine.commit.commit({
            projectId,
            branch,
            path,
            title: path,
            summary: `summary ${i}`,
            content,
            sourceSurface: "opencode-cli",
            author: "agent:test",
            requestedStatus: "verified",
            verificationEventId: event.id,
          }),
          "EVIDENCE_REQUIRED",
        );
        counts.rejected += 1;
      } else if (roll < 0.76) {
        // A non-promoting kind can never promote.
        const event = await insertVerificationEvent(database, {
          id: ids.id("vev"),
          projectId,
          kind:
            NON_PROMOTING_KINDS[Math.floor(random() * NON_PROMOTING_KINDS.length)] ?? "lint_pass",
          exitCode: 0,
          now: clock.now(),
        });
        await expectFailure(
          engine.commit.commit({
            projectId,
            branch,
            path,
            title: path,
            summary: `summary ${i}`,
            content,
            sourceSurface: "opencode-cli",
            author: "agent:test",
            requestedStatus: "verified",
            verificationEventId: event.id,
          }),
          "EVIDENCE_REQUIRED",
        );
        counts.rejected += 1;
      } else if (roll < 0.81) {
        // A verified request with no event id at all.
        await expectFailure(
          engine.commit.commit({
            projectId,
            branch,
            path,
            title: path,
            summary: `summary ${i}`,
            content,
            sourceSurface: "opencode-cli",
            author: "agent:test",
            requestedStatus: "verified",
          }),
          "EVIDENCE_REQUIRED",
        );
        counts.rejected += 1;
      } else if (roll < 0.86) {
        // A web surface cannot self-promote, even with valid evidence.
        const event = await insertVerificationEvent(database, {
          id: ids.id("vev"),
          projectId,
          kind: "test_pass",
          exitCode: 0,
          now: clock.now(),
        });
        await expectFailure(
          engine.commit.commit({
            projectId,
            branch,
            path,
            title: path,
            summary: `summary ${i}`,
            content,
            sourceSurface: WEB_SURFACES[Math.floor(random() * WEB_SURFACES.length)] ?? "gemini-web",
            author: "agent:test",
            requestedStatus: "verified",
            verificationEventId: event.id,
          }),
          "EVIDENCE_REQUIRED",
        );
        counts.rejected += 1;
      } else if (roll < 0.95) {
        // Byte-identical re-commit: inherits verified status and evidence, or
        // stays unverified. Title and summary are identical too, because any
        // text change demotes.
        const previousText = lastText.get(key);
        if (previousText === undefined) {
          result = await engine.commit.commit({
            projectId,
            branch,
            path,
            title: path,
            summary: "seed",
            content,
            sourceSurface: "opencode-cli",
            author: "agent:test",
          });
          counts.unverified += 1;
        } else {
          result = await engine.commit.commit({
            projectId,
            branch,
            path,
            title: path,
            summary: lastSummary.get(key) ?? "seed",
            content: previousText,
            sourceSurface: "opencode-cli",
            author: "agent:test",
          });
          counts.inherited += 1;
        }
      } else if (roll < 0.98) {
        // Deprecation drops trust.
        result = await engine.commit.commit({
          projectId,
          branch,
          path,
          title: path,
          summary: `summary ${i}`,
          content,
          sourceSurface: "opencode-cli",
          author: "agent:test",
          requestedStatus: "deprecated",
        });
        counts.deprecated += 1;
      } else {
        // Optimistic-concurrency mismatch: no write at all.
        await expectFailure(
          engine.commit.commit({
            projectId,
            branch,
            path,
            title: path,
            summary: `summary ${i}`,
            content,
            sourceSurface: "opencode-cli",
            author: "agent:test",
            expectedVersion: (lastVersion.get(key) ?? 0) + 1,
          }),
          "VERSION_CONFLICT",
        );
        counts.rejected += 1;
      }

      if (result !== null) {
        counts.successes += 1;
        // Immediate per-commit invariant: a verified result names its event and
        // a non-verified result carries none.
        if (result.status === "verified") {
          expect(result.verificationEventId).not.toBeNull();
          expect(result.node.status).toBe("verified");
        } else {
          expect(result.verificationEventId).toBeNull();
          expect(result.node.verificationEventId).toBeNull();
          expect(result.node.verifiedTreeHash).toBeNull();
        }
        if (result.demoted) counts.demoted += 1;

        lastText.set(key, result.node.content);
        lastSummary.set(key, result.node.summary);
        lastVersion.set(key, result.version);
      }

      // The invariant is checked periodically, not only at the end: a head
      // that becomes unevidenced for a moment is still a bug.
      if ((i + 1) % 1_000 === 0) {
        await assertEveryVerifiedHeadIsEvidenced(database, projectId);
      }
    }

    const verifiedHeads = await assertEveryVerifiedHeadIsEvidenced(database, projectId);

    // The workload must actually exercise the paths it claims to test. A
    // sequence that never promoted anything would pass the invariant vacuously.
    expect(counts.verified).toBeGreaterThan(100);
    expect(counts.inherited).toBeGreaterThan(0);
    expect(counts.rejected).toBeGreaterThan(500);
    expect(counts.demoted).toBeGreaterThan(100);
    expect(counts.deprecated).toBeGreaterThan(0);
    expect(verifiedHeads).toBeGreaterThan(0);

    // Every successful commit wrote exactly one version, and every rejected
    // write left no row behind.
    const versionCount = await database.execute("SELECT count(*) AS n FROM node_versions");
    expect(Number(versionCount.rows[0]?.n)).toBe(counts.successes);
  }, 600_000);
});
