import type { Clock, IdGenerator } from "@chronos-ctx/shared-types";
import type { Database } from "../db/client.js";
import { requireBranch, setBranchHead } from "../repositories/branches.js";
import {
  type Checkpoint,
  type CheckpointKind,
  getBranchHead,
  insertCheckpoint,
  listCheckpoints,
} from "../repositories/checkpoints.js";
import type { Snapshot } from "../repositories/snapshots.js";
import { captureState } from "./snapshots.js";

/**
 * A state-only checkpoint is the Phase 1 half of D6: snapshot row, then
 * checkpoint row, then branch head — in one transaction. The file tree half is
 * Phase 2 and reuses this ordering.
 */

export interface CreateStateCheckpointInput {
  projectId: string;
  branch: string;
  message?: string;
  kind?: CheckpointKind;
  authorSurface?: string | null;
}

export interface StateCheckpointResult {
  checkpoint: Checkpoint;
  snapshot: Snapshot;
  deduped: boolean;
}

export class CheckpointService {
  private readonly db: Database;
  private readonly ids: IdGenerator;
  private readonly clock: Clock;

  public constructor(options: { db: Database; ids: IdGenerator; clock: Clock }) {
    this.db = options.db;
    this.ids = options.ids;
    this.clock = options.clock;
  }

  public async createStateOnly(input: CreateStateCheckpointInput): Promise<StateCheckpointResult> {
    const now = this.clock.now();
    return this.db.withTx(async (tx) => {
      const branch = await requireBranch(tx, input.projectId, input.branch);
      const captured = await captureState(tx, this.ids, input.projectId, input.branch, now);

      const checkpoint = await insertCheckpoint(tx, {
        checkpointId: this.ids.id("chk"),
        projectId: input.projectId,
        branchName: input.branch,
        parentCheckpointId: branch.headCheckpointId,
        snapshotId: captured.snapshot.id,
        snapshotHash: captured.snapshot.snapshotHash,
        snapshotKind: "state_only",
        storage: "none",
        gitTreeHash: null,
        gitCommitHash: null,
        gitRef: null,
        alternates: 0,
        fileCount: 0,
        nodeCount: captured.snapshot.nodeCount,
        message: input.message ?? "",
        kind: input.kind ?? "manual",
        authorSurface: input.authorSurface ?? null,
        agentId: null,
        sessionId: null,
        createdAt: now,
      });

      await setBranchHead(tx, input.projectId, input.branch, checkpoint.checkpointId, now);

      return { checkpoint, snapshot: captured.snapshot, deduped: !captured.inserted };
    });
  }

  public async head(projectId: string, branch: string): Promise<Checkpoint | null> {
    return getBranchHead(this.db, projectId, branch);
  }

  public async list(projectId: string, branch: string, limit = 50): Promise<Checkpoint[]> {
    return listCheckpoints(this.db, projectId, branch, limit);
  }
}
