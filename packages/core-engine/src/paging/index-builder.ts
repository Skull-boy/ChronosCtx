import type { HeadSummary } from "../repositories/nodes.js";
import type { IndexMode } from "../repositories/projects.js";

/**
 * Boot index construction (§1.7). The default is counts per group: Phase 0
 * measured 183 tokens for counts-only versus 387 with summaries on a 300-node
 * project, so summaries are opt-in and the caller pays for them explicitly.
 */

export interface IndexCounts {
  nodes: number;
  verified: number;
  unverified: number;
  deprecated: number;
}

export interface IndexGroup extends IndexCounts {
  prefix: string;
}

export interface IndexBuild {
  mode: "flat" | "grouped";
  counts: IndexCounts;
  groups: IndexGroup[];
  omittedGroups: number;
  paths: string[];
  omittedPaths: number;
}

export interface IndexOptions {
  mode?: IndexMode;
  maxGroups?: number;
  maxPaths?: number;
}

const AUTO_GROUP_THRESHOLD = 40;

function emptyCounts(): IndexCounts {
  return { nodes: 0, verified: 0, unverified: 0, deprecated: 0 };
}

function addStatus(counts: IndexCounts, status: HeadSummary["status"]): void {
  counts.nodes += 1;
  if (status === "verified") counts.verified += 1;
  else if (status === "deprecated") counts.deprecated += 1;
  else counts.unverified += 1;
}

function groupPrefix(path: string): string {
  const index = path.indexOf("/");
  return index < 0 ? path : path.slice(0, index);
}

export function buildIndex(heads: readonly HeadSummary[], options: IndexOptions = {}): IndexBuild {
  const requested = options.mode ?? "auto";
  const mode: "flat" | "grouped" =
    requested === "auto" ? (heads.length > AUTO_GROUP_THRESHOLD ? "grouped" : "flat") : requested;

  const counts = emptyCounts();
  const byPrefix = new Map<string, IndexGroup>();

  for (const head of heads) {
    addStatus(counts, head.status);
    // Retired decisions stay retrievable by explicit path but do not occupy the
    // boot index (§2.6 rule 5).
    if (head.status === "deprecated") continue;
    if (mode === "grouped") {
      const prefix = groupPrefix(head.path);
      let group = byPrefix.get(prefix);
      if (group === undefined) {
        group = { prefix, ...emptyCounts() };
        byPrefix.set(prefix, group);
      }
      addStatus(group, head.status);
    }
  }

  if (mode === "flat") {
    const sorted = [...heads].map((head) => head.path).sort();
    const maxPaths = options.maxPaths ?? 24;
    return {
      mode,
      counts,
      groups: [],
      omittedGroups: 0,
      paths: sorted.slice(0, maxPaths),
      omittedPaths: Math.max(0, sorted.length - maxPaths),
    };
  }

  const allGroups = [...byPrefix.values()].sort((a, b) => {
    if (b.nodes !== a.nodes) return b.nodes - a.nodes;
    return a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0;
  });
  const maxGroups = options.maxGroups ?? 8;

  return {
    mode,
    counts,
    groups: allGroups.slice(0, maxGroups),
    omittedGroups: Math.max(0, allGroups.length - maxGroups),
    paths: [],
    omittedPaths: 0,
  };
}
