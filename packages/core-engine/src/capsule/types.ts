import type { Freshness, NodeStatus } from "@chronos-ctx/shared-types";

/**
 * Capsule v1 (roadmap §4.6, ADR-0009).
 *
 * The text is the artifact; this JSON travels beside it so a caller can compare
 * identities without parsing prose. Every field here is stable: no timestamps,
 * no durations, no host names, no pids, no absolute paths.
 */

export const CAPSULE_PROTOCOL = "capsule-v1" as const;
export const CAPSULE_HEADER = "CHRONOS CAPSULE v1" as const;

export interface CapsuleNode {
  path: string;
  version: number;
  status: NodeStatus;
  freshness: Freshness;
  freshness_reason: string;
  summary: string;
}

export interface CapsuleConstraint {
  id: string;
  node_path: string | null;
  failed_approach: string;
  failure_reason: string;
  severity: "caution" | "blocking";
  evidence_kind: string;
  occurrences: number;
}

export interface CapsuleSideEffect {
  id: string;
  kind: string;
  description: string;
  reversible: boolean;
}

/** What the renderer removed to fit the budget, by category. */
export interface CapsuleDropped {
  deprecated: number;
  hypothesis_lines: number;
  hypothesis_summaries: number;
  constraint_lines: number;
  constraint_details: number;
  side_effect_lines: number;
  side_effect_details: number;
  verified_summaries: number;
  verified_nodes: number;
}

export interface CapsuleBudgets {
  capsule: number;
  hard: number;
  used: number;
}

export interface CapsuleV1 {
  schema_version: 1;
  protocol: typeof CAPSULE_PROTOCOL;
  project: { id: string; slug: string };
  branch: string;
  snapshot_hash: string;
  content_root: string;
  head_checkpoint_id: string;
  tree_hash: string | null;
  objective: string | null;
  nodes: CapsuleNode[];
  constraints: CapsuleConstraint[];
  side_effects: CapsuleSideEffect[];
  budgets: CapsuleBudgets;
  generator_version: string;
  render_hash: string;
  truncated: boolean;
  dropped: CapsuleDropped;
}

export function emptyDropped(): CapsuleDropped {
  return {
    deprecated: 0,
    hypothesis_lines: 0,
    hypothesis_summaries: 0,
    constraint_lines: 0,
    constraint_details: 0,
    side_effect_lines: 0,
    side_effect_details: 0,
    verified_summaries: 0,
    verified_nodes: 0,
  };
}
