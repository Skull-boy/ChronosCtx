import {
  BUDGETS,
  ChronosError,
  type DaemonIdentity,
  type EnforcementTier,
  type Envelope,
  type Estimator,
  estimate,
  type Freshness,
  type SourceSurface,
  validatePath,
  type Warning,
} from "@chronos-ctx/shared-types";
import type { Database } from "../db/client.js";
import {
  type FreshnessContext,
  type FreshnessResult,
  freshnessMarker,
  nodeFreshness,
} from "../epistemic/freshness.js";
import { requireBranch } from "../repositories/branches.js";
import { listConstraintsForPath, type NegativeConstraint } from "../repositories/constraints.js";
import { EDGE_RELS, type EdgeRel, listNeighbors, type Neighbor } from "../repositories/edges.js";
import {
  getHead,
  getNodeView,
  getVersion,
  listHeads,
  type NodeHead,
  type NodeView,
  resolveAlias,
} from "../repositories/nodes.js";
import { getProjectById } from "../repositories/projects.js";
import { getVerificationEvent } from "../repositories/verification.js";
import { cutToTokens, type FitResult, fitToBudget, measureText } from "./budget.js";
import { envelopeFactory, makeEnvelope } from "./envelope.js";

/**
 * `context_page_in` (§4.5.2): detail on demand, bounded, labelled.
 *
 * The response is assembled from whole nodes in request order. When the budget
 * is tight, whole nodes are dropped from the tail, then the final node is cut at
 * a sentence boundary. Status and freshness markers are never the thing that is
 * dropped; a node that cannot carry its marker is removed instead.
 */

export interface PageInInput {
  projectId: string;
  branch?: string;
  paths: readonly string[];
  maxTokens?: number;
  includeNegativeConstraints?: boolean;
  versionPolicy?: "head" | "pinned";
  pinnedVersions?: Readonly<Record<string, string>>;
  expand?: readonly EdgeRel[];
  suggestEvict?: boolean;
  format?: "markdown" | "json";
  surface?: SourceSurface;
  tier?: EnforcementTier;
  schemaTokens?: number;
  daemon?: DaemonIdentity;
  freshness?: FreshnessContext;
  /** Paths paged earlier in this session; used only for eviction hints. */
  previouslyPaged?: readonly string[];
}

export interface PageInConstraint {
  failed_approach: string;
  failure_reason: string;
  severity: "blocking" | "caution";
  occurrences: number;
  evidence_kind: string;
}

export interface PageInNode {
  path: string;
  resolved_from?: string;
  title: string;
  summary: string;
  content: string;
  status: "unverified" | "verified" | "deprecated";
  freshness: Freshness;
  freshness_reason: string;
  verified_tree_hash: string | null;
  version: number;
  version_id: string;
  content_hash: string;
  source_surface: string;
  updated_at: string;
  tokens: { content: number; envelope: number; total: number };
  truncated: boolean;
  edges: Array<{ rel: string; to_path: string; summary: string | null }>;
  negative_constraints: PageInConstraint[];
}

export interface PageInResult {
  nodes: PageInNode[];
  missing: Array<{ path: string; suggestions: string[] }>;
  text: string;
  total_tokens: number;
  estimator: Estimator;
  eviction_hint: string;
  evict_candidates?: string[];
  envelope: Envelope;
  warnings: Warning[];
  truncated: boolean;
  fits: boolean;
}

interface Resolved {
  view: NodeView;
  requestedPath: string;
  resolvedFrom: string | null;
  freshness: FreshnessResult;
  constraints: NegativeConstraint[];
  edges: Neighbor[];
}

interface RenderableNode {
  resolved: Resolved;
  content: string;
  truncated: boolean;
}

type Item =
  | { kind: "node"; display: number; node: RenderableNode }
  | { kind: "missing"; display: number; text: string }
  | { kind: "hint"; display: number; text: string };

const MAX_PATHS = 12;
const DEFAULT_MAX_TOKENS = BUDGETS.page_in.hard;
const HARD_MAX_TOKENS = 4000;
const MIN_MAX_TOKENS = 100;
const CONSTRAINT_LIMIT = BUDGETS.negative_constraints.default;

function clampTokens(value: number | undefined): number {
  const requested = value ?? DEFAULT_MAX_TOKENS;
  return Math.min(HARD_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, Math.trunc(requested)));
}

function suggest(path: string, heads: readonly NodeHead[]): string[] {
  const leaf = path.split("/").pop() ?? path;
  return heads
    .map((head) => head.path)
    .filter(
      (candidate) =>
        candidate !== path &&
        (candidate.endsWith(`/${leaf}`) ||
          candidate.startsWith(`${path}/`) ||
          path.startsWith(`${candidate}/`)),
    )
    .sort()
    .slice(0, 3);
}

function wrapContent(node: RenderableNode): string {
  const { view, freshness } = node.resolved;
  const label = `${view.nodePath}@v${view.version}`;
  const body = node.content;

  if (view.status === "unverified") {
    return `<<<UNVERIFIED ${label} — hypotheses only>>>\n${body}\n<<<END UNVERIFIED>>>`;
  }
  if (view.status === "deprecated") {
    return `<<<DEPRECATED ${label} — retired, kept for reference>>>\n${body}\n<<<END DEPRECATED>>>`;
  }
  if (freshness.value === "stale") {
    return `<<<STALE — verified against ${view.verifiedTreeHash ?? "unknown tree"}, current tree differs>>>\n${body}\n<<<END STALE>>>`;
  }
  if (freshness.value === "unknown") {
    return `<<<FRESHNESS UNKNOWN — ${freshness.reason}>>>\n${body}\n<<<END FRESHNESS UNKNOWN>>>`;
  }
  return body;
}

function renderMarkdownNode(node: RenderableNode): string {
  const { view, freshness, constraints, edges } = node.resolved;
  const lines: string[] = [
    `## ${view.nodePath}@v${view.version} · ${view.status} · ${freshnessMarker(freshness)}`,
    view.title,
    view.summary,
    wrapContent(node),
  ];

  for (const edge of edges) {
    const summary = edge.summary === null ? "" : ` — ${edge.summary}`;
    lines.push(`→ ${edge.rel}: ${edge.toPath}${summary}`);
  }
  for (const constraint of constraints.slice(0, CONSTRAINT_LIMIT)) {
    lines.push(
      `DO NOT: ${constraint.failedApproach} → ${constraint.failureReason} (${constraint.severity})`,
    );
  }
  return lines.join("\n");
}

function renderJsonNode(node: RenderableNode): string {
  const { view, freshness, constraints, edges } = node.resolved;
  return JSON.stringify({
    path: view.nodePath,
    title: view.title,
    summary: view.summary,
    content: node.content,
    status: view.status,
    freshness: freshness.value,
    freshness_reason: freshness.reason,
    version: view.version,
    version_id: view.versionId,
    content_hash: view.contentHash,
    source_surface: view.sourceSurface,
    edges: edges.map((edge) => ({
      rel: edge.rel,
      to_path: edge.toPath,
      summary: edge.summary,
    })),
    negative_constraints: constraints.map((constraint) => ({
      failed_approach: constraint.failedApproach,
      failure_reason: constraint.failureReason,
      severity: constraint.severity,
      occurrences: constraint.occurrences,
      evidence_kind: constraint.evidenceKind,
    })),
  });
}

export class PageInService {
  private readonly db: Database;

  public constructor(options: { db: Database }) {
    this.db = options.db;
  }

  public async pageIn(input: PageInInput): Promise<PageInResult> {
    if (input.paths.length === 0) {
      throw new ChronosError("PATH_INVALID", "at least one path is required");
    }
    if (input.paths.length > MAX_PATHS) {
      throw new ChronosError(
        "BUDGET_EXCEEDED",
        `requested ${input.paths.length} paths; the maximum is ${MAX_PATHS}`,
        { hint: "Page in the next step only; request the rest after the current work lands." },
      );
    }

    const project = await getProjectById(this.db, input.projectId);
    if (project === null) {
      throw new ChronosError("PROJECT_NOT_FOUND", `project ${input.projectId} does not exist`);
    }
    const branchName = input.branch ?? project.defaultBranch;
    await requireBranch(this.db, project.id, branchName);

    const requested = this.normalizePaths(input.paths);
    const format = input.format ?? "markdown";
    const maxTokens = clampTokens(input.maxTokens);
    const includeConstraints = input.includeNegativeConstraints !== false;
    const expand = input.expand ?? [];
    if (expand.length > 3) {
      throw new ChronosError(
        "BUDGET_EXCEEDED",
        `requested ${expand.length} edge relations; the maximum is 3`,
      );
    }
    for (const rel of expand) {
      if (!EDGE_RELS.has(rel)) {
        throw new ChronosError("NODE_INVALID", `unknown edge relation "${rel}"`);
      }
    }
    const freshnessContext = input.freshness ?? null;
    let warnings: Warning[] = [];
    const heads = await listHeads(this.db, project.id, branchName);

    const resolved: Resolved[] = [];
    const missing: Array<{ path: string; suggestions: string[] }> = [];

    for (const requestedPath of requested) {
      const alias = await resolveAlias(this.db, project.id, branchName, requestedPath);
      if (alias.path !== requestedPath) {
        warnings.push({
          code: "ALIAS_REDIRECT",
          message: `"${requestedPath}" was renamed to "${alias.path}"`,
          path: alias.path,
        });
      }

      const view = await this.resolveView(
        project.id,
        branchName,
        requestedPath,
        alias.path,
        input.versionPolicy ?? "head",
        input.pinnedVersions ?? {},
      );

      if (view === null) {
        missing.push({ path: requestedPath, suggestions: suggest(requestedPath, heads) });
        continue;
      }

      const nodeFreshnessResult = await this.computeNodeFreshness(view, freshnessContext);
      const constraints = includeConstraints
        ? await listConstraintsForPath(
            this.db,
            project.id,
            branchName,
            view.nodePath,
            CONSTRAINT_LIMIT,
          )
        : [];
      const edges = await listNeighbors(this.db, project.id, branchName, view.nodePath, expand, 9);
      for (const edge of edges) {
        if (edge.summary === null) {
          warnings.push({
            code: "EDGE_ORPHANED",
            message: `edge ${view.nodePath} → ${edge.toPath} has no head on ${branchName}`,
            path: edge.toPath,
          });
        }
      }

      if (view.status === "deprecated") {
        warnings.push({
          code: "DEPRECATED",
          message: `${view.nodePath}@v${view.version} is deprecated`,
          path: view.nodePath,
        });
      } else if (view.status === "unverified") {
        warnings.push({
          code: "UNVERIFIED_CONTENT",
          message: `${view.nodePath}@v${view.version} is unverified`,
          path: view.nodePath,
        });
      } else if (nodeFreshnessResult.value === "stale") {
        warnings.push({
          code: "STALE_EVIDENCE",
          message: `${view.nodePath}@v${view.version}: ${nodeFreshnessResult.reason}`,
          path: view.nodePath,
        });
      }

      resolved.push({
        view,
        requestedPath,
        resolvedFrom: alias.path === requestedPath ? null : requestedPath,
        freshness: nodeFreshnessResult,
        constraints,
        edges,
      });
    }

    const evictCandidates =
      input.suggestEvict === true
        ? this.evictCandidates(resolved, input.previouslyPaged ?? [])
        : [];

    const items: Item[] = [];
    resolved.forEach((node, index) => {
      items.push({
        kind: "node",
        display: index,
        node: { resolved: node, content: node.view.content, truncated: false },
      });
    });

    if (missing.length > 0) {
      const suffix = missing
        .map((entry) =>
          entry.suggestions.length > 0
            ? `${entry.path} (try: ${entry.suggestions.join(", ")})`
            : entry.path,
        )
        .join(" · ");
      items.push({ kind: "missing", display: 900, text: `missing: ${suffix}` });
    }

    const evictionHint =
      "After the next commit, page out paths you no longer need; commit before you drop them.";
    items.push({
      kind: "hint",
      display: 901,
      text: evictionHint,
    });

    // Most important first, so `fitToBudget` drops nodes from the tail.
    const ordered: Item[] = [
      ...items.filter((item) => item.kind === "missing"),
      ...items.filter((item) => item.kind === "hint"),
      ...items.filter((item) => item.kind === "node"),
    ];

    const renderNode = (node: RenderableNode): string =>
      format === "json" ? renderJsonNode(node) : renderMarkdownNode(node);

    const render = (kept: readonly Item[]): string =>
      [...kept]
        .sort((a, b) => a.display - b.display)
        .map((item) => {
          if (item.kind === "node") return renderNode(item.node);
          return item.text;
        })
        .join("\n\n");

    const fitWith = (fitWarnings: Warning[]): FitResult<Item> =>
      fitToBudget<Item>({
        items: ordered,
        render,
        envelope: envelopeFactory({
          surface: input.surface ?? "cli",
          tier: input.tier ?? "T1",
          ...(input.daemon === undefined ? {} : { daemon: input.daemon }),
          warnings: fitWarnings,
        }),
        schemaTokens: input.schemaTokens ?? 0,
        maxTokens,
        cutLast: (item, budget) => {
          if (item.kind !== "node") return null;
          const fixed = renderNode({ ...item.node, content: "" });
          const available = budget - measureText(fixed);
          if (available < 5) return null;
          const cut = cutToTokens(item.node.content, available);
          if (cut === null || cut === item.node.content) return null;
          return {
            ...item,
            node: { ...item.node, content: cut, truncated: true },
          };
        },
      });

    let fitted = fitWith(warnings);
    if (fitted.truncated) {
      warnings = [
        ...warnings,
        {
          code: "TRUNCATED",
          message: `page_in truncated to stay within ${maxTokens}`,
        },
      ];
      // The warning is inside the envelope; refit so the reported total is real.
      fitted = fitWith(warnings);
    }

    return this.resultFrom(fitted, warnings, missing, evictionHint, evictCandidates, input, format);
  }

  private resultFrom(
    fitted: FitResult<Item>,
    warnings: Warning[],
    missing: Array<{ path: string; suggestions: string[] }>,
    evictionHint: string,
    evictCandidates: string[],
    input: PageInInput,
    format: "markdown" | "json",
  ): PageInResult {
    const keptNodes = fitted.items
      .filter((item): item is Extract<Item, { kind: "node" }> => item.kind === "node")
      .sort((a, b) => a.display - b.display)
      .map((item) => this.toResultNode(item.node, format));

    return {
      nodes: keptNodes,
      missing,
      text: fitted.text,
      total_tokens: fitted.tokens.total,
      estimator: "chars4",
      eviction_hint: evictionHint,
      ...(input.suggestEvict === true ? { evict_candidates: evictCandidates } : {}),
      envelope: makeEnvelope({
        surface: input.surface ?? "cli",
        tier: input.tier ?? "T1",
        tokens: fitted.tokens,
        ...(input.daemon === undefined ? {} : { daemon: input.daemon }),
        warnings,
      }),
      warnings,
      truncated: fitted.truncated,
      fits: fitted.fits,
    };
  }

  private normalizePaths(paths: readonly string[]): string[] {
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const path of paths) {
      const result = validatePath(path);
      if (!result.ok) {
        throw new ChronosError(result.code, result.reason, { details: { path } });
      }
      if (!seen.has(result.path)) {
        seen.add(result.path);
        normalized.push(result.path);
      }
    }
    return normalized;
  }

  private async resolveView(
    projectId: string,
    branch: string,
    requestedPath: string,
    resolvedPath: string,
    policy: "head" | "pinned",
    pinnedVersions: Readonly<Record<string, string>>,
  ): Promise<NodeView | null> {
    const head = await getHead(this.db, projectId, branch, resolvedPath);

    if (policy === "pinned") {
      const pinned = pinnedVersions[requestedPath] ?? pinnedVersions[resolvedPath];
      if (pinned !== undefined) {
        const version = await getVersion(this.db, pinned);
        if (version === null || version.projectId !== projectId) {
          throw new ChronosError("NODE_NOT_FOUND", `pinned version ${pinned} does not exist`, {
            details: { path: requestedPath, version_id: pinned },
          });
        }
        if (version.nodePath !== resolvedPath) {
          throw new ChronosError(
            "NODE_NOT_FOUND",
            `pinned version ${pinned} belongs to ${version.nodePath}, not ${resolvedPath}`,
            { details: { path: requestedPath, version_id: pinned } },
          );
        }
        return {
          ...version,
          headId: head?.id ?? "",
          branch,
          updatedAt: head?.updatedAt ?? version.createdAt,
        };
      }
    }

    return getNodeView(this.db, projectId, branch, resolvedPath);
  }

  private async computeNodeFreshness(
    view: NodeView,
    context: FreshnessContext | null,
  ): Promise<FreshnessResult> {
    const event =
      view.verificationEventId === null
        ? null
        : await getVerificationEvent(this.db, view.verificationEventId);
    return nodeFreshness({
      status: view.status,
      verifiedTreeHash: view.verifiedTreeHash,
      coveredPaths: event?.coveredPaths ?? [],
      context,
    });
  }

  private evictCandidates(
    resolved: readonly Resolved[],
    previouslyPaged: readonly string[],
  ): string[] {
    if (previouslyPaged.length === 0) return [];
    const current = new Set(resolved.map((node) => node.view.nodePath));
    const referenced = new Set<string>();
    for (const node of resolved) {
      for (const edge of node.edges) referenced.add(edge.toPath);
    }
    return previouslyPaged.filter((path) => !current.has(path) && !referenced.has(path)).sort();
  }

  private toResultNode(node: RenderableNode, format: "markdown" | "json"): PageInNode {
    const { view, freshness, constraints, edges } = node.resolved;
    const content = format === "json" ? renderJsonNode(node) : renderMarkdownNode(node);
    const tokens = estimate(content);
    return {
      path: view.nodePath,
      ...(node.resolved.resolvedFrom === null ? {} : { resolved_from: node.resolved.resolvedFrom }),
      title: view.title,
      summary: view.summary,
      content: node.content,
      status: view.status,
      freshness: freshness.value,
      freshness_reason: freshness.reason,
      verified_tree_hash: view.verifiedTreeHash,
      version: view.version,
      version_id: view.versionId,
      content_hash: view.contentHash,
      source_surface: view.sourceSurface,
      updated_at: new Date(view.updatedAt).toISOString(),
      tokens: { content: tokens, envelope: 0, total: tokens },
      truncated: node.truncated,
      edges: edges.map((edge) => ({
        rel: edge.rel,
        to_path: edge.toPath,
        summary: edge.summary,
      })),
      negative_constraints: constraints.slice(0, CONSTRAINT_LIMIT).map((constraint) => ({
        failed_approach: constraint.failedApproach,
        failure_reason: constraint.failureReason,
        severity: constraint.severity,
        occurrences: constraint.occurrences,
        evidence_kind: constraint.evidenceKind,
      })),
    };
  }
}
