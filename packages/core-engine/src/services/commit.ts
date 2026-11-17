import {
  ChronosError,
  type Clock,
  type IdGenerator,
  isWebSurface,
  type NodeStatus,
  type SourceSurface,
  validatePath,
  type Warning,
} from "@chronos-ctx/shared-types";
import { contentHash } from "../content/hash.js";
import type { Database } from "../db/client.js";
import type { Sql } from "../db/sql.js";
import { inspectNodeSize, validateNodeShape } from "../domain/node.js";
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
import { getVerificationEvent, type VerificationKind } from "../repositories/verification.js";

/**
 * D1 + the epistemic gate at the write boundary.
 *
 * Everything that decides `status`, allocates a version or moves a head lives
 * here, inside one `BEGIN IMMEDIATE` transaction. No repository writes status on
 * its own.
 */

const PROMOTING_KINDS: ReadonlySet<VerificationKind> = new Set<VerificationKind>([
  "test_pass",
  "build_pass",
  "typecheck_pass",
  "user_approval",
]);

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
    const web = isWebSurface(input.sourceSurface);

    if (requested === "verified") {
      if (web) {
        throw new ChronosError(
          "EVIDENCE_REQUIRED",
          `surface "${input.sourceSurface}" cannot promote a node to verified`,
          {
            hint: "Verified state requires evidence from a local harness or an explicit approval.",
          },
        );
      }
      if (input.verificationEventId === undefined || input.verificationEventId === null) {
        throw new ChronosError(
          "EVIDENCE_REQUIRED",
          "status=verified requires verification evidence",
          {
            hint: "Run a check and pass verification_event_id, or commit with status=unverified.",
          },
        );
      }
    }

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
            {
              details: { path: fromPath },
            },
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

      const changed = previousVersion === null || previousVersion.contentHash !== hash;
      let status: NodeStatus;
      let newEvidenceTreeHash: string | null = null;

      if (requested === "deprecated") {
        status = "deprecated";
      } else if (requested === "verified") {
        const event = await this.requirePromotingEvent(
          tx,
          input.projectId,
          input.verificationEventId as string,
        );
        if (
          previousVersion !== null &&
          changed &&
          event.createdAt <= previousVersion.createdAt &&
          input.allowAgentOverride !== true
        ) {
          throw new ChronosError(
            "EVIDENCE_STALE",
            "content changed but the supplied evidence predates the previous version",
            {
              hint: "Re-run the check so the evidence is bound to the new content, or commit as unverified.",
              details: { verification_event_id: event.id },
            },
          );
        }
        newEvidenceTreeHash = event.treeHash;
        status = "verified";
      } else {
        // Identical text re-committed (same content_hash) keeps trust; any
        // text change — including a title or summary edit — demotes.
        status =
          previousVersion !== null && previousVersion.status === "verified" && !changed
            ? "verified"
            : "unverified";
      }

      const maxVersion = await maxVersionNumber(tx, input.projectId, path);
      const version = Math.max(maxVersion, previousHead?.version ?? 0) + 1;
      const versionId = this.ids.id("ver");

      // A verified version must always cite evidence. When trust is inherited by
      // re-committing identical text, the previous evidence travels with it.
      const evidenceEventId =
        status === "verified"
          ? (input.verificationEventId ?? previousVersion?.verificationEventId ?? null)
          : null;
      if (status === "verified" && evidenceEventId === null) {
        throw new ChronosError(
          "INTERNAL",
          "refusing to write a verified version without a verification event",
        );
      }

      await insertVersion(tx, {
        versionId,
        projectId: input.projectId,
        nodePath: path,
        version,
        title: input.title,
        summary: input.summary,
        content: input.content,
        contentHash: hash,
        status,
        sourceSurface: input.sourceSurface,
        sourceRef: input.sourceRef ?? null,
        author: input.author ?? null,
        createdOnBranch: input.branch,
        verificationEventId: evidenceEventId,
        verifiedTreeHash:
          status === "verified"
            ? (newEvidenceTreeHash ?? previousVersion?.verifiedTreeHash ?? null)
            : null,
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
        status,
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
        status,
        previousVersion: previousHead?.version ?? null,
        previousVersionId: previousHead?.headVersionId ?? null,
        demoted: previousVersion?.status === "verified" && status === "unverified",
        verificationEventId: evidenceEventId,
        renamedFrom: renameFrom,
        warnings,
        node,
      };
    });
  }

  private async requirePromotingEvent(
    tx: Sql,
    projectId: string,
    eventId: string,
  ): Promise<{ id: string; createdAt: number; treeHash: string | null }> {
    const event = await getVerificationEvent(tx, eventId);
    if (event === null) {
      throw new ChronosError("EVIDENCE_REQUIRED", `verification event ${eventId} does not exist`, {
        details: { verification_event_id: eventId },
      });
    }
    if (event.projectId !== projectId) {
      throw new ChronosError("EVIDENCE_REQUIRED", "verification event belongs to another project");
    }
    if (!PROMOTING_KINDS.has(event.kind)) {
      throw new ChronosError(
        "EVIDENCE_REQUIRED",
        `verification kind "${event.kind}" cannot promote a node`,
        { hint: "Use test_pass, build_pass, typecheck_pass or user_approval." },
      );
    }
    if (event.exitCode !== null && event.exitCode !== 0) {
      throw new ChronosError(
        "EVIDENCE_REQUIRED",
        `verification event reports exit code ${event.exitCode}; only 0 can promote`,
      );
    }
    return { id: event.id, createdAt: event.createdAt, treeHash: event.treeHash };
  }
}
