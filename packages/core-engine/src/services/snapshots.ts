import type { Clock, IdGenerator } from "@chronos-ctx/shared-types";
import { contentRoot, snapshotHash } from "../content/hash.js";
import { encodeSnapshotBody } from "../content/snapshot.js";
import type { Database } from "../db/client.js";
import type { Sql } from "../db/sql.js";
import { listHeads } from "../repositories/nodes.js";
import {
  ensureSnapshot,
  type Snapshot,
  type SnapshotStats,
  snapshotStats,
} from "../repositories/snapshots.js";

/**
 * D5: capture the state of a branch as two identities — a local
 * `snapshot_hash` over `path → version_id` and a portable `content_root` over
 * `path → content_hash`. The row is written with `ON CONFLICT DO NOTHING`, so a
 * repeated capture is free.
 */

export interface CaptureResult {
  snapshot: Snapshot;
  inserted: boolean;
  entries: Array<{ path: string; versionId: string; contentHash: string }>;
}

export async function captureState(
  tx: Sql,
  ids: IdGenerator,
  projectId: string,
  branch: string,
  now: number,
): Promise<CaptureResult> {
  const heads = await listHeads(tx, projectId, branch);
  const entries: CaptureResult["entries"] = [];

  for (const head of heads) {
    const result = await tx.execute({
      sql: "SELECT content_hash FROM node_versions WHERE version_id = ?",
      args: [head.headVersionId],
    });
    const row = result.rows[0];
    if (row === undefined) continue;
    const hash = row.content_hash;
    if (typeof hash !== "string") continue;
    entries.push({ path: head.path, versionId: head.headVersionId, contentHash: hash });
  }

  const snapshotEntries = entries.map((entry) => ({
    path: entry.path,
    versionId: entry.versionId,
  }));
  const rootEntries = entries.map((entry) => ({
    path: entry.path,
    contentHash: entry.contentHash,
  }));

  const body = encodeSnapshotBody(snapshotEntries);
  const ensured = await ensureSnapshot(tx, {
    id: ids.id("snp"),
    projectId,
    snapshotHash: snapshotHash(snapshotEntries),
    contentRoot: contentRoot(rootEntries),
    body,
    nodeCount: entries.length,
    bytes: body.byteLength,
    now,
  });

  return { snapshot: ensured.snapshot, inserted: ensured.inserted, entries };
}

export class SnapshotService {
  private readonly db: Database;
  private readonly ids: IdGenerator;
  private readonly clock: Clock;

  public constructor(options: { db: Database; ids: IdGenerator; clock: Clock }) {
    this.db = options.db;
    this.ids = options.ids;
    this.clock = options.clock;
  }

  public async capture(projectId: string, branch: string): Promise<CaptureResult> {
    const now = this.clock.now();
    return this.db.withTx(async (tx) => captureState(tx, this.ids, projectId, branch, now));
  }

  public async stats(projectId: string): Promise<SnapshotStats> {
    return snapshotStats(this.db, projectId);
  }
}
