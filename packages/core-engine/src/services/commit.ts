import {
  ChronosError,
  type Clock,
  type IdGenerator,
  type NodeStatus,
  type SourceSurface,
  validatePath,
  type Warning,
} from "@chronos-ctx/shared-types";
import { contentHash } from "../content/hash.js";
import type { Database } from "../db/client.js";
import type { Sql } from "../db/sql.js";
import { inspectNodeSize, validateNodeShape } from "../domain/node.js";
import { decideStatus, type EvidenceView } from "../epistemic/gate.js";
import { assertWritable } from "../repositories/branches.js";
import {
  deleteHead,
  getHead,
  getNodeView,
  getVersion,
  insertAlias,
  insertVersion,
  maxVersionNumber,
  type NodeView,
  resolveAlias,
  upsertHead,
} from "../repositories/nodes.js";
import { getVerificationEvent } from "../repositories/verification.js";

/**
 * D1 at the write boundary.
 *
 * This service owns version allocation and the transaction; the status decision
 * itself belongs to `epistemic/gate.ts` and is not duplicated here.
 */

export interface CommitInput {
  projectId: string;
  branch: string;
  path: string;
  title: string;
  summary: string;
  content: string;
  sourceSurface: SourceSurface;
  author?: string | null;
  sourceRef?: string | null;
  requestedStatus?: NodeStatus;
  verificationEventId?: string | null;
  expectedVersion?: number;
  /** Rename: this path is replaced by `path`, and an alias is written. */
  fromPath?: string;
  /** Policy escape hatch; never available to a web surface (ADR-0005). */
  allowAgentOverride?: boolean;
}

export interface CommitResult {
  path: string;
  version: number;
  versionId: string;
  status: NodeStatus;
  previousVersion: number | null;
  previousVersionId: string | null;
  demoted: boolean;
  verificationEventId: string | null;
  renamedFrom: string | null;
  warnings: Warning[];
  node: NodeView;
}

function normalizePathOrThrow(input: string): string {
  const result = validatePath(input);
  if (!result.ok) {
    throw new ChronosError(result.code, result.reason, { details: { path: input } });
  }
  return result.path;
}

function assertShape(node: { title: string; summary: string; content: string }): void {
  const problems = validateNodeShape(node);
  if (problems.length > 0) {
    throw new ChronosError("NODE_INVALID", problems[0]?.message ?? "invalid node", {
      details: { problems },
    });
  }
}

export class CommitService {
  private readonly db: Database;
  private readonly ids: IdGenerator;
  private readonly clock: Clock;

  public constructor(options: { db: Database; ids: IdGenerator; clock: Clock }) {
    this.db = options.db;
    this.ids = options.ids;
    this.clock = options.clock;
  }

  public async commit(input: CommitInput): Promise<CommitResult> {
    const path = normalizePathOrThrow(input.path);
    const fromPath =
      input.fromPath === undefined ? undefined : normalizePathOrThrow(input.fromPath);
    assertShape(input);
    const size = inspectNodeSize(input, path);
    const warnings: Warning[] = size.warning === undefined ? [] : [size.warning];
    const now = this.clock.now();
    const requested = input.requestedStatus ?? "unverified";

    const hash = contentHash({
      title: input.title,
      summary: input.summary,
      content: input.content,
    });

    return this.db.withTx(async (tx) => {
      await assertWritable(tx, input.projectId, input.branch);

      // A commit to a stale path would silently resurrect a node that was
      // renamed; page_in may follow aliases, writes may not.
      const alias = await resolveAlias(tx, input.projectId, input.branch, path);
      if (alias.path !== path) {
        throw new ChronosError("ALIAS_REDIRECT", `"${path}" was renamed to "${alias.path}"`, {
          details: { path: alias.path, aliases: alias.aliases },
        });
      }

      let previousHead = await getHead(tx, input.projectId, input.branch, path);
      let renameFrom: string | null = null;

      if (fromPath !== undefined) {
        const oldAlias = await resolveAlias(tx, input.projectId, input.branch, fromPath);
        if (oldAlias.path !== fromPath) {
          throw new ChronosError(
            "ALIAS_REDIRECT",
            `"${fromPath}" was already renamed to "${oldAlias.path}"`,
            { details: { path: oldAlias.path } },
          );
        }
        const oldHead = await getHead(tx, input.projectId, input.branch, fromPath);
        if (oldHead === null) {
          throw new ChronosError(
            "NODE_NOT_FOUND",
            `cannot rename "${fromPath}": it does not exist`,
            { details: { path: fromPath } },
          );
        }
        if (previousHead !== null && previousHead.path !== fromPath) {
          throw new ChronosError(
            "CONFLICT",
            `cannot rename onto "${path}": the destination already exists`,
            { details: { path } },
          );
        }
        previousHead = oldHead;
        renameFrom = fromPath;
      }

      const previousVersion =
        previousHead === null ? null : await getVersion(tx, previousHead.headVersionId);

      if (
        input.expectedVersion !== undefined &&
        input.expectedVersion !== (previousHead?.version ?? 0)
      ) {
        throw new ChronosError(
          "VERSION_CONFLICT",
          `expected version ${input.expectedVersion} but the current version is ${previousHead?.version ?? 0}`,
          {
            details: {
              path,
              current_version: previousHead?.version ?? 0,
              current_version_id: previousHead?.headVersionId ?? null,
              current_content_hash: previousVersion?.contentHash ?? null,
            },
          },
        );
      }

      const evidence =
        requested === "verified" && input.verificationEventId
          ? await this.loadEvidence(tx, input.projectId, input.verificationEventId)
          : null;

      const decision = decideStatus({
        requested,
        previous:
          previousVersion === null
            ? null
            : {
                status: previousVersion.status,
                contentHash: previousVersion.contentHash,
                verificationEventId: previousVersion.verificationEventId,
                verifiedTreeHash: previousVersion.verifiedTreeHash,
                createdAt: previousVersion.createdAt,
              },
        newContentHash: hash,
        sourceSurface: input.sourceSurface,
        evidence,
        allowAgentOverride: input.allowAgentOverride === true,
      });

      const maxVersion = await maxVersionNumber(tx, input.projectId, path);
      const version = Math.max(maxVersion, previousHead?.version ?? 0) + 1;
      const versionId = this.ids.id("ver");

      await insertVersion(tx, {
        versionId,
        projectId: input.projectId,
        nodePath: path,
        version,
        title: input.title,
        summary: input.summary,
        content: input.content,
        contentHash: hash,
        status: decision.status,
        sourceSurface: input.sourceSurface,
        sourceRef: input.sourceRef ?? null,
        author: input.author ?? null,
        createdOnBranch: input.branch,
        verificationEventId: decision.verificationEventId,
        verifiedTreeHash: decision.verifiedTreeHash,
        supersedesVersionId: previousVersion?.versionId ?? null,
        forkedFromVersionId: null,
        tokensEstimate: size.tokens,
        createdAt: now,
      });

      if (renameFrom !== null) {
        await insertAlias(tx, {
          projectId: input.projectId,
          branch: input.branch,
          oldPath: renameFrom,
          newPath: path,
          now,
        });
        await deleteHead(tx, input.projectId, input.branch, renameFrom);
      }

      await upsertHead(tx, {
        id: this.ids.id("nod"),
        projectId: input.projectId,
        branch: input.branch,
        path,
        headVersionId: versionId,
        version,
        status: decision.status,
        updatedAt: now,
      });

      const node = await getNodeView(tx, input.projectId, input.branch, path);
      if (node === null) {
        throw new ChronosError("INTERNAL", "committed node is not readable");
      }

      return {
        path,
        version,
        versionId,
        status: decision.status,
        previousVersion: previousHead?.version ?? null,
        previousVersionId: previousHead?.headVersionId ?? null,
        demoted: decision.demoted,
        verificationEventId: decision.verificationEventId,
        renamedFrom: renameFrom,
        warnings,
        node,
      };
    });
  }

  private async loadEvidence(tx: Sql, projectId: string, eventId: string): Promise<EvidenceView> {
    const event = await getVerificationEvent(tx, eventId);
    if (event === null) {
      throw new ChronosError("EVIDENCE_REQUIRED", `verification event ${eventId} does not exist`, {
        details: { verification_event_id: eventId },
      });
    }
    if (event.projectId !== projectId) {
      throw new ChronosError("EVIDENCE_REQUIRED", "verification event belongs to another project");
    }
    return {
      id: event.id,
      kind: event.kind,
      exitCode: event.exitCode,
      createdAt: event.createdAt,
      treeHash: event.treeHash,
    };
  }
}
