import {
  BUDGETS,
  ChronosError,
  type DaemonIdentity,
  type EnforcementTier,
  type Envelope,
  type SourceSurface,
  type TokenAccounting,
  type Warning,
} from "@chronos-ctx/shared-types";
import type { Database } from "../db/client.js";
import { requireBranch } from "../repositories/branches.js";
import { getBranchHead } from "../repositories/checkpoints.js";
import { type ConstraintStats, constraintStats } from "../repositories/constraints.js";
import { type HeadSummary, listHeadSummaries } from "../repositories/nodes.js";
import { getProjectById } from "../repositories/projects.js";
import { fitToBudget } from "./budget.js";
import { envelopeFactory, makeEnvelope } from "./envelope.js";
import { buildIndex, type IndexBuild, type IndexCounts, type IndexGroup } from "./index-builder.js";

/**
 * `context_boot` (§4.5.1): a small, deterministic index, not a transcript.
 *
 * The default is counts per group. Summaries are opt-in. Sections are dropped in
 * a fixed order when the budget is tight, so the result is reproducible and the
 * caller can see what was lost (`truncated`, `omitted_tokens`, warning).
 */

export interface BootInput {
  projectId: string;
  branch?: string;
  maxTokens?: number;
  includeSummaries?: boolean;
  indexMode?: "auto" | "flat" | "grouped";
  surface?: SourceSurface;
  tier?: EnforcementTier;
  schemaTokens?: number;
  daemon?: DaemonIdentity;
}

export interface BootResult {
  text: string;
  project: { id: string; slug: string; name: string };
  branch: string;
  checkpointId: string | null;
  objective: string | null;
  counts: IndexCounts;
  groups: IndexGroup[];
  omittedGroups: number;
  paths: string[];
  omittedPaths: number;
  constraints: ConstraintStats;
  includeSummaries: boolean;
  tokens: TokenAccounting;
  envelope: Envelope;
  warnings: Warning[];
  truncated: boolean;
  fits: boolean;
}

interface Section {
  id: string;
  display: number;
  text: string;
}

function clampTokens(value: number | undefined): number {
  const requested = value ?? BUDGETS.boot.default;
  return Math.min(BUDGETS.boot.hard, Math.max(50, Math.trunc(requested)));
}

function groupLine(index: IndexBuild): string {
  if (index.mode === "flat") {
    if (index.paths.length === 0) return "paths: (none)";
    const suffix = index.omittedPaths > 0 ? ` · +${index.omittedPaths}` : "";
    return `paths: ${index.paths.join(" · ")}${suffix}`;
  }
  if (index.groups.length === 0) return "groups: (none)";
  const groups = index.groups.map((group) => `${group.prefix} ${group.nodes}`).join(" · ");
  const suffix = index.omittedGroups > 0 ? ` · +${index.omittedGroups}` : "";
  return `groups: ${groups}${suffix}`;
}

function summaryLine(head: HeadSummary): string {
  return `${head.path}@v${head.version} [${head.status}] — ${head.summary}`;
}

export class BootService {
  private readonly db: Database;

  public constructor(options: { db: Database }) {
    this.db = options.db;
  }

  public async boot(input: BootInput): Promise<BootResult> {
    const project = await getProjectById(this.db, input.projectId);
    if (project === null) {
      throw new ChronosError("PROJECT_NOT_FOUND", `project ${input.projectId} does not exist`);
    }
    const branchName = input.branch ?? project.defaultBranch;
    await requireBranch(this.db, project.id, branchName);

    const [head, heads, constraints] = await Promise.all([
      getBranchHead(this.db, project.id, branchName),
      listHeadSummaries(this.db, project.id, branchName),
      constraintStats(this.db, project.id, branchName),
    ]);

    const index = buildIndex(heads, {
      mode: input.indexMode ?? project.indexMode,
    });
    const includeSummaries = input.includeSummaries === true;
    const maxTokens = clampTokens(input.maxTokens);
    const surface = input.surface ?? "cli";
    const tier = input.tier ?? "T1";
    const schemaTokens = input.schemaTokens ?? 0;

    const sections: Section[] = [
      { id: "header", display: 0, text: "CHRONOS BOOT v1" },
      {
        id: "identity",
        display: 1,
        text: `project: ${project.slug}@${branchName}${head === null ? "" : ` · head ${head.checkpointId}`}`,
      },
      {
        id: "counts",
        display: 2,
        text: `state: ${index.counts.nodes} nodes · ${index.counts.verified} verified · ${index.counts.unverified} unverified · ${index.counts.deprecated} deprecated`,
      },
      {
        id: "constraints",
        display: 10,
        text:
          constraints.blocking > 0
            ? `constraints: ${constraints.active} active (${constraints.blocking} blocking)`
            : `constraints: ${constraints.active} active`,
      },
    ];

    if (project.activeObjective !== null && project.activeObjective.length > 0) {
      sections.push({
        id: "objective",
        display: 11,
        text: `objective: ${project.activeObjective}`,
      });
    }

    sections.push({
      id: "resume",
      display: 12,
      text: "resume: page in only the next step; commit with evidence.",
    });

    if (includeSummaries) {
      let line = 0;
      for (const node of heads) {
        sections.push({
          id: `node:${node.path}`,
          display: 3 + line,
          text: summaryLine(node),
        });
        line += 1;
      }
    } else {
      sections.push({ id: "index", display: 3, text: groupLine(index) });
    }

    // Drop order: summary lines from the tail, then objective, resume,
    // constraints, counts, identity, header. The array is ordered most
    // important first so `fitToBudget` can drop from its tail.
    const ordered = [
      sections.find((section) => section.id === "header"),
      sections.find((section) => section.id === "identity"),
      sections.find((section) => section.id === "counts"),
      sections.find((section) => section.id === "constraints"),
      sections.find((section) => section.id === "resume"),
      sections.find((section) => section.id === "objective"),
      ...sections.filter((section) => section.id === "index" || section.id.startsWith("node:")),
    ].filter((section): section is Section => section !== undefined);

    const fittedOnce = fitToBudget({
      items: ordered,
      render: (kept) =>
        [...kept]
          .sort((a, b) => a.display - b.display)
          .map((section) => section.text)
          .join("\n"),
      envelope: envelopeFactory({
        surface,
        tier,
        ...(input.daemon === undefined ? {} : { daemon: input.daemon }),
      }),
      schemaTokens,
      maxTokens,
    });

    // The truncation warning is part of the envelope, so it must be measured.
    // Refit with it rather than reporting a budget the client does not receive.
    let warnings: Warning[] = [];
    let fitted = fittedOnce;
    if (fittedOnce.truncated) {
      warnings = [
        {
          code: "TRUNCATED",
          message: `boot index truncated to stay within ${maxTokens}`,
        },
      ];
      fitted = fitToBudget({
        items: ordered,
        render: (kept) =>
          [...kept]
            .sort((a, b) => a.display - b.display)
            .map((section) => section.text)
            .join("\n"),
        envelope: envelopeFactory({
          surface,
          tier,
          ...(input.daemon === undefined ? {} : { daemon: input.daemon }),
          warnings,
        }),
        schemaTokens,
        maxTokens,
      });
    }

    return {
      text: fitted.text,
      project: { id: project.id, slug: project.slug, name: project.name },
      branch: branchName,
      checkpointId: head?.checkpointId ?? null,
      objective: project.activeObjective,
      counts: index.counts,
      groups: index.groups,
      omittedGroups: index.omittedGroups,
      paths: index.paths,
      omittedPaths: index.omittedPaths,
      constraints,
      includeSummaries,
      tokens: fitted.tokens,
      envelope: makeEnvelope({
        surface,
        tier,
        tokens: fitted.tokens,
        ...(input.daemon === undefined ? {} : { daemon: input.daemon }),
        warnings,
      }),
      warnings,
      truncated: fitted.truncated,
      fits: fitted.fits,
    };
  }
}
