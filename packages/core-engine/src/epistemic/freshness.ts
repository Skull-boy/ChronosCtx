import type { Freshness } from "@chronos-ctx/shared-types";

/**
 * Tree-bound freshness (D2, ADR-0014).
 *
 * A tree is a map of workspace-relative path → content hash. In Phase 1 the map
 * is supplied by the caller (tests, imports, future daemon); in Phase 2 the
 * shadow repository produces it. The rule is deliberately independent of how the
 * diff is computed:
 *
 *   fresh   ⇔ no path in `diff(evidence, current)` is covered by `coveredPaths`
 *   stale   ⇔ at least one is
 *   unknown ⇔ no evidence tree, no current tree, or no covered paths
 *
 * Freshness is never stored; it is computed for the response that renders it.
 */

export type TreeState = ReadonlyMap<string, string>;

export interface TreeDiff {
  added: string[];
  removed: string[];
  modified: string[];
}

export function diffTrees(before: TreeState, after: TreeState): TreeDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];

  for (const [path, hash] of after) {
    const previous = before.get(path);
    if (previous === undefined) added.push(path);
    else if (previous !== hash) modified.push(path);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) removed.push(path);
  }

  return {
    added: added.sort(),
    removed: removed.sort(),
    modified: modified.sort(),
  };
}

export function changedPaths(diff: TreeDiff): string[] {
  return [...diff.added, ...diff.removed, ...diff.modified].sort();
}

/** A covered path covers itself and every descendant. */
export function isCovered(path: string, coveredPaths: readonly string[]): boolean {
  for (const covered of coveredPaths) {
    const normalized = covered.replace(/\/+$/u, "");
    if (normalized.length === 0) continue;
    if (path === normalized || path.startsWith(`${normalized}/`)) return true;
  }
  return false;
}

export interface FreshnessInput {
  evidenceTree: TreeState | null;
  currentTree: TreeState | null;
  coveredPaths: readonly string[];
}

export interface FreshnessResult {
  value: Freshness;
  reason: string;
  /** Changed paths that fall under at least one covered path. */
  changedCoveredPaths: string[];
}

export function computeFreshness(input: FreshnessInput): FreshnessResult {
  if (input.evidenceTree === null) {
    return {
      value: "unknown",
      reason: "no tree recorded with the evidence",
      changedCoveredPaths: [],
    };
  }
  if (input.currentTree === null) {
    return { value: "unknown", reason: "no workspace attached", changedCoveredPaths: [] };
  }

  const covered = input.coveredPaths.filter((path) => path.length > 0);
  if (covered.length === 0) {
    return { value: "unknown", reason: "no covered paths recorded", changedCoveredPaths: [] };
  }

  const diff = diffTrees(input.evidenceTree, input.currentTree);
  const touched = changedPaths(diff).filter((path) => isCovered(path, covered));

  if (touched.length === 0) {
    return { value: "fresh", reason: "no covered path changed", changedCoveredPaths: [] };
  }

  return {
    value: "stale",
    reason: `tree changed in ${touched.length} covered path${touched.length === 1 ? "" : "s"}`,
    changedCoveredPaths: touched,
  };
}

/** Renders the marker the daemon must emit; it cannot be suppressed (ADR-0005). */
export function freshnessMarker(result: FreshnessResult): string {
  switch (result.value) {
    case "fresh":
      return "[fresh]";
    case "stale":
      return `[stale: ${result.reason}]`;
    case "unknown":
      return `[unknown: ${result.reason}]`;
  }
}
