import {
  ChronosError,
  isWebSurface,
  type NodeStatus,
  type SourceSurface,
} from "@chronos-ctx/shared-types";
import type { VerificationKind } from "../repositories/verification.js";

/**
 * The epistemic gate (ADR-0005). This module is the only place a status
 * transition is decided; repositories write the value they are given, and no
 * route or CLI path computes one on its own.
 *
 * Keeping the decision pure is what makes the invariant testable without a
 * database: every rule in §2.6 is a function of the requested status, the
 * previous version, the new content hash, the authenticated surface and the
 * evidence.
 */

const PROMOTING_KINDS: ReadonlySet<VerificationKind> = new Set<VerificationKind>([
  "test_pass",
  "build_pass",
  "typecheck_pass",
  "user_approval",
]);

export interface EvidenceView {
  id: string;
  kind: VerificationKind;
  exitCode: number | null;
  createdAt: number;
  treeHash: string | null;
}

export interface PreviousVersionView {
  status: NodeStatus;
  contentHash: string;
  verificationEventId: string | null;
  verifiedTreeHash: string | null;
  createdAt: number;
}

export interface GateRequest {
  requested: NodeStatus;
  previous: PreviousVersionView | null;
  newContentHash: string;
  sourceSurface: SourceSurface;
  /** Present only when the caller supplied `verification_event_id`. */
  evidence: EvidenceView | null;
  allowAgentOverride: boolean;
}

export interface GateDecision {
  status: NodeStatus;
  demoted: boolean;
  verificationEventId: string | null;
  verifiedTreeHash: string | null;
}

export function isPromotingKind(kind: VerificationKind): boolean {
  return PROMOTING_KINDS.has(kind);
}

export function decideStatus(request: GateRequest): GateDecision {
  const changed =
    request.previous === null || request.previous.contentHash !== request.newContentHash;

  if (request.requested === "verified") {
    // Authenticated surface, not the payload: a web surface cannot promote even
    // with a well-formed event id or an inline "evidence" block.
    if (isWebSurface(request.sourceSurface)) {
      throw new ChronosError(
        "EVIDENCE_REQUIRED",
        `surface "${request.sourceSurface}" cannot promote a node to verified`,
        { hint: "Verified state requires evidence from a local harness or an explicit approval." },
      );
    }

    const evidence = request.evidence;
    if (evidence === null) {
      throw new ChronosError(
        "EVIDENCE_REQUIRED",
        "status=verified requires verification evidence",
        {
          hint: "Run a check and pass verification_event_id, or commit with status=unverified.",
        },
      );
    }
    if (!PROMOTING_KINDS.has(evidence.kind)) {
      throw new ChronosError(
        "EVIDENCE_REQUIRED",
        `verification kind "${evidence.kind}" cannot promote a node`,
        { hint: "Use test_pass, build_pass, typecheck_pass or user_approval." },
      );
    }
    if (evidence.exitCode !== null && evidence.exitCode !== 0) {
      throw new ChronosError(
        "EVIDENCE_REQUIRED",
        `verification event reports exit code ${evidence.exitCode}; only 0 can promote`,
      );
    }
    if (
      request.previous !== null &&
      changed &&
      evidence.createdAt <= request.previous.createdAt &&
      !request.allowAgentOverride
    ) {
      throw new ChronosError(
        "EVIDENCE_STALE",
        "content changed but the supplied evidence predates the previous version",
        {
          hint: "Re-run the check so the evidence is bound to the new content, or commit as unverified.",
          details: { verification_event_id: evidence.id },
        },
      );
    }

    return {
      status: "verified",
      demoted: false,
      verificationEventId: evidence.id,
      verifiedTreeHash: evidence.treeHash,
    };
  }

  if (request.requested === "deprecated") {
    return {
      status: "deprecated",
      demoted: false,
      verificationEventId: null,
      verifiedTreeHash: null,
    };
  }

  // A re-commit of byte-identical text inherits trust and its evidence. Any
  // text change — including title or summary — demotes (ADR-0005).
  if (request.previous !== null && request.previous.status === "verified" && !changed) {
    if (request.previous.verificationEventId === null) {
      throw new ChronosError(
        "INTERNAL",
        "a verified head has no verification event; refusing to inherit unprovable trust",
      );
    }
    return {
      status: "verified",
      demoted: false,
      verificationEventId: request.previous.verificationEventId,
      verifiedTreeHash: request.previous.verifiedTreeHash,
    };
  }

  return {
    status: "unverified",
    demoted: request.previous?.status === "verified",
    verificationEventId: null,
    verifiedTreeHash: null,
  };
}
