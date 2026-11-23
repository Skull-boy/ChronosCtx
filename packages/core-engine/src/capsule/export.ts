import { BUDGETS, ChronosError } from "@chronos-ctx/shared-types";
import { renderHash } from "../content/hash.js";
import { decodeSnapshotBody } from "../content/snapshot.js";
import type { Database } from "../db/client.js";
import { type FreshnessContext, nodeFreshness } from "../epistemic/freshness.js";
import { engineVersion } from "../paging/envelope.js";
import { requireBranch } from "../repositories/branches.js";
import {
  type Checkpoint,
  getBranchHead,
  getCheckpoint,
  requireCheckpoint,
} from "../repositories/checkpoints.js";
import { listActiveConstraints } from "../repositories/constraints.js";
import { getVersion } from "../repositories/nodes.js";
import { getProjectById } from "../repositories/projects.js";
import { listSideEffectsInRange } from "../repositories/side-effects.js";
import { getSnapshot } from "../repositories/snapshots.js";
import { getVerificationEvent } from "../repositories/verification.js";
import { renderCapsule } from "./render.js";
import {
  CAPSULE_PROTOCOL,
  type CapsuleConstraint,
  type CapsuleNode,
  type CapsuleSideEffect,
  type CapsuleV1,
} from "./types.js";

/**
 * Builds a capsule from a checkpoint's snapshot, never from live heads
 * (ADR-0009 §7). A concurrent commit cannot produce a capsule that mixes two
 * states, and the header can be checked against the checkpoint it names.
 */

export interface CapsuleExportInput {
  projectId: string;
  branch?: string;
  checkpointId?: string;
  maxTokens?: number;
  /** Overrides the project's active objective in the rendered text. */
  objective?: string | null;
  /** Tree inputs for freshness; without them every verified node is `unknown`. */
  freshness?: FreshnessContext | null;
}

export interface CapsuleExportResult {
  text: string;
  capsule: CapsuleV1;
  tokens: number;
  truncated: boolean;
}

const CONSTRAINT_LIMIT = BUDGETS.negative_constraints.hard;
const SIDE_EFFECT_LIMIT = 10;

export class CapsuleService {
  private readonly db: Database;

  public constructor(options: { db: Database }) {
    this.db = options.db;
  }

  public async export(input: CapsuleExportInput): Promise<CapsuleExportResult> {
    const project = await getProjectById(this.db, input.projectId);
    if (project === null) {
      throw new ChronosError("PROJECT_NOT_FOUND", `project ${input.projectId} does not exist`);
    }

    const checkpoint = await this.resolveCheckpoint(project.id, project.defaultBranch, input);
    const branchName = checkpoint.branchName;
    if (input.branch !== undefined && input.branch !== branchName) {
      throw new ChronosError(
        "CHECKPOINT_NOT_FOUND",
        `checkpoint ${checkpoint.checkpointId} belongs to branch "${branchName}", not "${input.branch}"`,
      );
    }
    await requireBranch(this.db, project.id, branchName);

    const snapshot = await getSnapshot(this.db, checkpoint.snapshotId);
    if (snapshot === null) {
      throw new ChronosError(
        "INTERNAL",
        `checkpoint ${checkpoint.checkpointId} references missing snapshot ${checkpoint.snapshotId}`,
      );
    }

    const entries = decodeSnapshotBody(snapshot.body);
    const nodes: CapsuleNode[] = [];
    for (const entry of entries) {
      const version = await getVersion(this.db, entry.versionId);
      if (version === null) {
        throw new ChronosError(
          "INTERNAL",
          `snapshot ${snapshot.id} references missing version ${entry.versionId}`,
        );
      }
      const event =
        version.verificationEventId === null
          ? null
          : await getVerificationEvent(this.db, version.verificationEventId);
      const freshness = nodeFreshness({
        status: version.status,
        verifiedTreeHash: version.verifiedTreeHash,
        coveredPaths: event?.coveredPaths ?? [],
        context: input.freshness ?? null,
      });
      nodes.push({
        path: version.nodePath,
        version: version.version,
        status: version.status,
        freshness: freshness.value,
        freshness_reason: freshness.reason,
        summary: version.summary,
      });
    }

    const constraints: CapsuleConstraint[] = (
      await listActiveConstraints(this.db, project.id, branchName, CONSTRAINT_LIMIT)
    ).map((constraint) => ({
      id: constraint.id,
      node_path: constraint.nodePath,
      failed_approach: constraint.failedApproach,
      failure_reason: constraint.failureReason,
      severity: constraint.severity,
      evidence_kind: constraint.evidenceKind,
      occurrences: constraint.occurrences,
    }));

    const parent =
      checkpoint.parentCheckpointId === null
        ? null
        : await getCheckpoint(this.db, checkpoint.parentCheckpointId);
    const sideEffects: CapsuleSideEffect[] = (
      await listSideEffectsInRange(
        this.db,
        project.id,
        branchName,
        parent?.createdAt ?? 0,
        checkpoint.createdAt,
        SIDE_EFFECT_LIMIT,
      )
    ).map((effect) => ({
      id: effect.id,
      kind: effect.kind,
      description: effect.description,
      reversible: effect.reversible,
    }));

    const objective = input.objective === undefined ? project.activeObjective : input.objective;

    const rendered = renderCapsule({
      project: { id: project.id, slug: project.slug },
      branch: branchName,
      snapshotHash: checkpoint.snapshotHash,
      contentRoot: snapshot.contentRoot,
      headCheckpointId: checkpoint.checkpointId,
      treeHash: checkpoint.gitTreeHash,
      objective,
      nodes,
      constraints,
      sideEffects,
      ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
    });

    const capsule: CapsuleV1 = {
      schema_version: 1,
      protocol: CAPSULE_PROTOCOL,
      project: { id: project.id, slug: project.slug },
      branch: branchName,
      snapshot_hash: checkpoint.snapshotHash,
      content_root: snapshot.contentRoot,
      head_checkpoint_id: checkpoint.checkpointId,
      tree_hash: checkpoint.gitTreeHash,
      objective,
      nodes,
      constraints,
      side_effects: sideEffects,
      budgets: {
        capsule: rendered.budget,
        hard: BUDGETS.capsule.hard,
        used: rendered.tokens,
      },
      generator_version: engineVersion(),
      render_hash: renderHash(rendered.text),
      truncated: rendered.truncated,
      dropped: rendered.dropped,
    };

    return {
      text: rendered.text,
      capsule,
      tokens: rendered.tokens,
      truncated: rendered.truncated,
    };
  }

  private async resolveCheckpoint(
    projectId: string,
    defaultBranch: string,
    input: CapsuleExportInput,
  ): Promise<Checkpoint> {
    if (input.checkpointId !== undefined) {
      const checkpoint = await requireCheckpoint(this.db, input.checkpointId);
      if (checkpoint.projectId !== projectId) {
        throw new ChronosError(
          "CHECKPOINT_NOT_FOUND",
          `checkpoint ${checkpoint.checkpointId} belongs to another project`,
        );
      }
      return checkpoint;
    }

    const branch = input.branch ?? defaultBranch;
    const head = await getBranchHead(this.db, projectId, branch);
    if (head === null) {
      throw new ChronosError(
        "CHECKPOINT_NOT_FOUND",
        `branch "${branch}" has no checkpoint; create one with context_checkpoint`,
      );
    }
    return head;
  }
}
