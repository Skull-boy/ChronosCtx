import { BUDGETS, estimate } from "@chronos-ctx/shared-types";
import { freshnessMarker } from "../epistemic/freshness.js";
import {
  CAPSULE_HEADER,
  type CapsuleConstraint,
  type CapsuleDropped,
  type CapsuleNode,
  type CapsuleSideEffect,
  emptyDropped,
} from "./types.js";

/**
 * Capsule renderer (roadmap §4.6, ADR-0009).
 *
 * The section order is contract, the markers are mandatory, and trimming is
 * staged in a fixed order so two runs on the same snapshot produce the same
 * bytes. Nothing volatile enters the text: no timestamp, duration, pid,
 * hostname or absolute path. `render_hash` therefore travels between machines.
 */

export interface CapsuleRenderInput {
  project: { id: string; slug: string };
  branch: string;
  snapshotHash: string;
  contentRoot: string;
  headCheckpointId: string;
  treeHash: string | null;
  objective: string | null;
  nodes: readonly CapsuleNode[];
  constraints: readonly CapsuleConstraint[];
  sideEffects: readonly CapsuleSideEffect[];
  maxTokens?: number;
}

export interface CapsuleRenderResult {
  text: string;
  tokens: number;
  budget: number;
  dropped: CapsuleDropped;
  truncated: boolean;
}

interface Stage {
  includeHypotheses: boolean;
  hypothesisDetail: boolean;
  includeConstraints: boolean;
  constraintDetail: boolean;
  includeSideEffects: boolean;
  sideEffectDetail: boolean;
  verifiedDetail: boolean;
}

const STAGES: readonly Stage[] = [
  {
    includeHypotheses: true,
    hypothesisDetail: true,
    includeConstraints: true,
    constraintDetail: true,
    includeSideEffects: true,
    sideEffectDetail: true,
    verifiedDetail: true,
  },
  {
    includeHypotheses: true,
    hypothesisDetail: false,
    includeConstraints: true,
    constraintDetail: true,
    includeSideEffects: true,
    sideEffectDetail: true,
    verifiedDetail: true,
  },
  {
    includeHypotheses: true,
    hypothesisDetail: false,
    includeConstraints: true,
    constraintDetail: false,
    includeSideEffects: true,
    sideEffectDetail: true,
    verifiedDetail: true,
  },
  {
    includeHypotheses: false,
    hypothesisDetail: false,
    includeConstraints: true,
    constraintDetail: false,
    includeSideEffects: true,
    sideEffectDetail: true,
    verifiedDetail: true,
  },
  {
    includeHypotheses: false,
    hypothesisDetail: false,
    includeConstraints: true,
    constraintDetail: false,
    includeSideEffects: true,
    sideEffectDetail: false,
    verifiedDetail: true,
  },
  {
    includeHypotheses: false,
    hypothesisDetail: false,
    includeConstraints: true,
    constraintDetail: false,
    includeSideEffects: true,
    sideEffectDetail: false,
    verifiedDetail: false,
  },
  {
    includeHypotheses: false,
    hypothesisDetail: false,
    includeConstraints: false,
    constraintDetail: false,
    includeSideEffects: false,
    sideEffectDetail: false,
    verifiedDetail: false,
  },
];

const RESUME =
  "RESUME PROTOCOL: page in only what the next step needs; commit with evidence;\n" +
  "rewind after two failed attempts. Do not re-derive the constraints above.";

export function clampCapsuleBudget(value: number | undefined): number {
  const requested = value ?? BUDGETS.capsule.default;
  // 150 is the floor where the header, objective, an empty VERIFIED section and
  // the resume protocol still fit; below that a section would have to disappear.
  return Math.min(BUDGETS.capsule.hard, Math.max(150, Math.trunc(requested)));
}

/**
 * Collapses whitespace so captured text cannot inject a section header or break
 * the one-line-per-item structure. Also keeps the render byte-stable.
 */
function line(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function byPath(a: { path: string }, b: { path: string }): number {
  if (a.path < b.path) return -1;
  if (a.path > b.path) return 1;
  return 0;
}

function nodeMarker(node: CapsuleNode): string {
  if (node.status === "verified") {
    return freshnessMarker({
      value: node.freshness,
      reason: node.freshness_reason,
      changedCoveredPaths: [],
    });
  }
  return `[unverified: ${line(node.freshness_reason)}]`;
}

function headerBlock(input: CapsuleRenderInput): string {
  const lines = [
    CAPSULE_HEADER,
    `project: ${input.project.slug} (${input.project.id})   branch: ${input.branch}`,
    `head: ${input.headCheckpointId}   tree: ${input.treeHash ?? "none"}   snapshot: ${input.snapshotHash}`,
  ];
  if (input.objective !== null && input.objective.trim().length > 0) {
    lines.push(`objective: ${line(input.objective)}`);
  }
  return lines.join("\n");
}

function verifiedBlock(nodes: readonly CapsuleNode[], detail: boolean): string {
  const lines = ["VERIFIED (trust):"];
  if (nodes.length === 0) {
    lines.push("- (none)");
    return lines.join("\n");
  }
  for (const node of nodes) {
    const summary = detail && node.summary.length > 0 ? ` — ${line(node.summary)}` : "";
    lines.push(`- ${node.path}@v${node.version} ${nodeMarker(node)}${summary}`);
  }
  return lines.join("\n");
}

function hypothesesBlock(nodes: readonly CapsuleNode[], detail: boolean): string {
  const lines = ["HYPOTHESES (validate before use):"];
  for (const node of nodes) {
    const summary = detail && node.summary.length > 0 ? ` — ${line(node.summary)}` : "";
    lines.push(`- ${node.path}@v${node.version} ${nodeMarker(node)}${summary}`);
  }
  return lines.join("\n");
}

function constraintTag(constraint: CapsuleConstraint): string {
  const promoted = constraint.severity === "blocking" ? ", blocking" : "";
  return `${line(constraint.evidence_kind)}${promoted}`;
}

function constraintsBlock(constraints: readonly CapsuleConstraint[], detail: boolean): string {
  const lines = ["DO NOT RETRY (caution unless promoted):"];
  for (const constraint of constraints) {
    if (detail) {
      lines.push(
        `- ${line(constraint.failed_approach)} → ${line(constraint.failure_reason)} (${constraintTag(constraint)})`,
      );
    } else {
      lines.push(`- ${line(constraint.failed_approach)} (${constraintTag(constraint)})`);
    }
  }
  return lines.join("\n");
}

function sideEffectsBlock(effects: readonly CapsuleSideEffect[], detail: boolean): string {
  const lines = ["SIDE EFFECTS IN RANGE:"];
  for (const effect of effects) {
    const reversibility = effect.reversible ? "reversible" : "not reversible";
    if (detail) {
      lines.push(`- ${line(effect.kind)}: ${line(effect.description)} (${reversibility})`);
    } else {
      lines.push(`- ${line(effect.kind)} (${reversibility})`);
    }
  }
  return lines.join("\n");
}

function buildText(
  input: CapsuleRenderInput,
  stage: Stage,
  verifiedLimit: number,
): { text: string; dropped: CapsuleDropped } {
  const verified = input.nodes
    .filter((node) => node.status === "verified")
    .sort(byPath)
    .slice(0, verifiedLimit);
  const hypotheses = stage.includeHypotheses
    ? input.nodes.filter((node) => node.status === "unverified").sort(byPath)
    : [];

  const sections: string[] = [headerBlock(input), verifiedBlock(verified, stage.verifiedDetail)];
  if (hypotheses.length > 0) {
    sections.push(hypothesesBlock(hypotheses, stage.hypothesisDetail));
  }
  if (input.constraints.length > 0 && stage.includeConstraints) {
    sections.push(constraintsBlock(input.constraints, stage.constraintDetail));
  }
  if (input.sideEffects.length > 0 && stage.includeSideEffects) {
    sections.push(sideEffectsBlock(input.sideEffects, stage.sideEffectDetail));
  }
  sections.push(RESUME);

  const dropped = emptyDropped();
  dropped.deprecated = input.nodes.filter((node) => node.status === "deprecated").length;
  dropped.hypothesis_lines = stage.includeHypotheses
    ? 0
    : input.nodes.filter((node) => node.status === "unverified").length;
  dropped.hypothesis_summaries =
    stage.includeHypotheses && !stage.hypothesisDetail
      ? input.nodes.filter((node) => node.status === "unverified").length
      : 0;
  dropped.constraint_lines = stage.includeConstraints ? 0 : input.constraints.length;
  dropped.constraint_details =
    stage.includeConstraints && !stage.constraintDetail ? input.constraints.length : 0;
  dropped.side_effect_lines = stage.includeSideEffects ? 0 : input.sideEffects.length;
  dropped.side_effect_details =
    stage.includeSideEffects && !stage.sideEffectDetail ? input.sideEffects.length : 0;
  dropped.verified_summaries = stage.verifiedDetail ? 0 : verified.length;
  dropped.verified_nodes = Math.max(
    0,
    input.nodes.filter((node) => node.status === "verified").length - verified.length,
  );

  return { text: sections.join("\n\n"), dropped };
}

export function renderCapsule(input: CapsuleRenderInput): CapsuleRenderResult {
  const budget = clampCapsuleBudget(input.maxTokens);
  const verifiedCount = input.nodes.filter((node) => node.status === "verified").length;

  for (const stage of STAGES) {
    const built = buildText(input, stage, verifiedCount);
    const tokens = estimate(built.text);
    if (tokens <= budget) {
      return {
        text: built.text,
        tokens,
        budget,
        dropped: built.dropped,
        truncated: isTruncated(built.dropped),
      };
    }
  }

  // Last resort: keep the header, the resume protocol, and as many verified
  // lines as fit. A capsule with no trust lines is still honest; a capsule that
  // silently drops its header or markers is not.
  for (let limit = verifiedCount - 1; limit >= 0; limit -= 1) {
    const built = buildText(input, STAGES[STAGES.length - 1] as Stage, limit);
    const tokens = estimate(built.text);
    if (tokens <= budget) {
      return {
        text: built.text,
        tokens,
        budget,
        dropped: built.dropped,
        truncated: true,
      };
    }
  }

  const minimal = buildText(input, STAGES[STAGES.length - 1] as Stage, 0);
  return {
    text: minimal.text,
    tokens: estimate(minimal.text),
    budget,
    dropped: minimal.dropped,
    truncated: true,
  };
}

function isTruncated(dropped: CapsuleDropped): boolean {
  return (
    dropped.hypothesis_lines > 0 ||
    dropped.hypothesis_summaries > 0 ||
    dropped.constraint_lines > 0 ||
    dropped.constraint_details > 0 ||
    dropped.side_effect_lines > 0 ||
    dropped.side_effect_details > 0 ||
    dropped.verified_summaries > 0 ||
    dropped.verified_nodes > 0
  );
}
