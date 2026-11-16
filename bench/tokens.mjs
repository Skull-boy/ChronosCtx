// Phase 0 / gates 0.4, 0.5, 0.6 + K4, K5, K6 — token surface and net-token model.
//
// Uses the real `js-tiktoken` (cl100k_base + o200k_base) on the exact JSON an
// MCP host receives: {name, description, inputSchema} per tool plus the server
// `instructions` string. Nothing is estimated with chars/4 except where the
// roadmap says chars4 is the default estimator — and both are reported.
import fs from "node:fs";
import { Tiktoken } from "js-tiktoken/lite";
import cl100k from "js-tiktoken/ranks/cl100k_base";
import o200k from "js-tiktoken/ranks/o200k_base";
import { arg, writeJson, rng } from "./lib/stats.mjs";

const OUT = arg("out", "bench/results/tokens.json");
const enc = {
  cl100k_base: new Tiktoken(cl100k),
  o200k_base: new Tiktoken(o200k),
};

function count(text, encoding = "cl100k_base") {
  return enc[encoding].encode(text).length;
}

/** The exact bytes an MCP host sees for one tool. */
function toolJson(name, description, inputSchema) {
  return JSON.stringify({ name, description, inputSchema });
}

const S = (type, extra = {}) => ({ type, ...extra });
const obj = (properties, required = [], extra = {}) => ({ type: "object", properties, required, additionalProperties: false, ...extra });

// ── The seven advertised tools, transcribed from §4.5.1–4.5.7 ──────────────
// Descriptions are deliberately terse: a model needs to know when to call the
// tool, not read the spec. Length of this text is the variable that decides K4.
const tools = [
  {
    name: "context_boot",
    description:
      "Start a session: return the project head, a token-budgeted index of nodes (paths, titles, status, freshness), global negative constraints, and the paging protocol. Call once at session start and after a branch switch. Never returns node content.",
    inputSchema: obj({
      project_id: S("string"),
      project_slug: S("string"),
      branch: S("string", { default: "main" }),
      budget_tokens: S("integer", { minimum: 100, maximum: 200, default: 150 }),
      index_mode: S("string", { enum: ["auto", "flat", "grouped"], default: "auto" }),
      include_global_constraints: S("boolean", { default: true }),
      probe_workspace: S("boolean", { default: false }),
      harness: S("string"),
      session_id: S("string"),
    }),
  },
  {
    name: "context_page_in",
    description:
      "Fetch the current version of up to 12 nodes by deterministic path, with status and freshness markers, one hop of edge summaries, and negative constraints. Annotated UNVERIFIED or STALE content is hypothesis; do not treat it as established fact. Re-page only when the version changed.",
    inputSchema: obj({
      project_id: S("string"),
      branch: S("string", { default: "main" }),
      paths: S("array", { items: S("string"), minItems: 1, maxItems: 12 }),
      max_tokens: S("integer", { minimum: 100, maximum: 4000, default: 1200 }),
      include_negative_constraints: S("boolean", { default: true }),
      version_policy: S("string", { enum: ["head", "pinned"], default: "head" }),
      pinned_versions: S("object", { additionalProperties: S("string") }),
      expand: S("array", { maxItems: 3, items: S("string", { enum: ["depends_on", "implements", "supersedes", "contradicts", "documents", "tests", "blocks", "related_to"] }) }),
      suggest_evict: S("boolean", { default: false }),
      format: S("string", { enum: ["markdown", "json"], default: "markdown" }),
    }),
  },
  {
    name: "context_commit",
    description:
      "Write or update one knowledge node at a path. Pass expected_version to avoid clobbering a concurrent write (VERSION_CONFLICT returns the current version). status=verified requires verification evidence. Changing content demotes verified to unverified. Call before risky edits.",
    inputSchema: obj({
      project_id: S("string"),
      branch: S("string", { default: "main" }),
      path: S("string"),
      title: S("string", { minLength: 1, maxLength: 120 }),
      summary: S("string", { minLength: 1, maxLength: 200 }),
      content: S("string", { minLength: 1, maxLength: 200000 }),
      status: S("string", { enum: ["unverified", "verified", "deprecated"], default: "unverified" }),
      expected_version: S("integer"),
      create_checkpoint: S("boolean", { default: false }),
      checkpoint_message: S("string", { maxLength: 200 }),
      is_green_build: S("boolean", { default: false }),
      verification: obj({
        kind: S("string", { enum: ["test_pass", "build_pass", "typecheck_pass", "user_approval"] }),
        command: S("string"),
        exit_code: S("integer"),
        covered_paths: S("array", { items: S("string") }),
        log_excerpt: S("string", { maxLength: 2000 }),
        harness: S("string"),
      }),
      verification_event_id: S("string"),
      source_ref: S("string"),
      idempotency_key: S("string"),
    }, ["path", "title", "summary", "content"]),
  },
  {
    name: "context_checkpoint",
    description:
      "Snapshot the whole workspace (files + knowledge state) as one atomic checkpoint on the current branch. Use before a risky multi-file change or when tests go green. Returns the checkpoint id, snapshot hash, and file counts. Never writes to the user's git repository.",
    inputSchema: obj({
      project_id: S("string"),
      branch: S("string", { default: "main" }),
      message: S("string", { minLength: 1, maxLength: 200 }),
      is_green_build: S("boolean", { default: false }),
      kind: S("string", { enum: ["manual", "auto_commit", "watch_green"], default: "manual" }),
      include_untracked: S("boolean", { default: true }),
      side_effects: S("array", { items: obj({
        kind: S("string", { enum: ["package_install", "migration", "external_write", "remote_push", "email", "cloud_resource", "other"] }),
        description: S("string", { minLength: 1, maxLength: 500 }),
        command: S("string"),
        reversible: S("boolean", { default: false }),
        undo_hint: S("string"),
      }, ["kind", "description"]) }),
      verification: obj({
        kind: S("string"), command: S("string"), exit_code: S("integer"),
        covered_paths: S("array", { items: S("string") }),
      }),
      idempotency_key: S("string"),
    }, ["message"]),
  },
  {
    name: "context_rewind",
    description:
      "Restore files and knowledge state to an earlier checkpoint, record the failed approach as a negative constraint, and return a rehydration capsule. Refuses when the worktree drifted unless force=true. Files created after the last checkpoint are preserved. Side effects are reported, not undone.",
    inputSchema: obj({
      project_id: S("string"),
      branch: S("string", { default: "main" }),
      target_checkpoint_id: S("string"),
      failed_approach: S("string", { minLength: 3, maxLength: 500 }),
      failure_reason: S("string", { minLength: 3, maxLength: 2000 }),
      restore_files: S("boolean", { default: true }),
      prune_untracked: S("boolean", { default: false }),
      constraint_scope: S("string", { enum: ["branch", "nodes"], default: "branch" }),
      force: S("boolean", { default: false }),
      dry_run: S("boolean", { default: false }),
      keep_current_as: S("string", { maxLength: 120 }),
    }, ["target_checkpoint_id", "failed_approach", "failure_reason"]),
  },
  {
    name: "context_fork",
    description:
      "Branch the project from a checkpoint (default: head) without copying blobs. Optionally materialize a detached worktree outside the user's workspace. Use to try an alternative without disturbing the current branch.",
    inputSchema: obj({
      project_id: S("string"),
      from_checkpoint_id: S("string"),
      new_branch_name: S("string", { pattern: "^[a-z0-9][a-z0-9._/-]{0,60}$" }),
      create_worktree: S("boolean", { default: false }),
      worktree_path: S("string"),
      copy_unverified_nodes: S("boolean", { default: true }),
      message: S("string", { maxLength: 200 }),
    }, ["new_branch_name"]),
  },
  {
    name: "context_flag_dead_end",
    description:
      "Record an approach that failed, with the observed reason, so future sessions do not repeat it. severity=blocking from an agent is downgraded to caution unless backed by a failing test or build. Deduplicated per branch and path.",
    inputSchema: obj({
      project_id: S("string"),
      branch: S("string"),
      node_path: S("string"),
      failed_approach: S("string", { minLength: 3, maxLength: 500 }),
      failure_reason: S("string", { minLength: 3, maxLength: 2000 }),
      evidence: obj({
        command: S("string"), exit_code: S("integer"), log_hash: S("string"),
        urls: S("array", { items: S("string"), maxItems: 5 }),
      }),
      evidence_kind: S("string", { enum: ["agent_reported", "test_failure", "build_failure", "user_reported", "incident"], default: "agent_reported" }),
      severity: S("string", { enum: ["caution", "blocking"], default: "caution" }),
      from_checkpoint_id: S("string"),
      idempotency_key: S("string"),
    }, ["failed_approach", "failure_reason"]),
  },
];

const instructions =
  "ChronosCtx is a stateful context store. Call context_boot once per session, then context_page_in for the paths a step needs. Cite path@version. Do not re-page a node whose version is unchanged. Treat UNVERIFIED or STALE content as hypothesis. Obey negative constraints. Call context_commit before risky edits; call context_rewind after two failed attempts on the same problem.";

const surface = {
  instructions,
  tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
};
const surfaceText = JSON.stringify(surface);

const perTool = tools.map((t) => {
  const j = toolJson(t.name, t.description, t.inputSchema);
  return {
    name: t.name,
    bytes: Buffer.byteLength(j, "utf8"),
    cl100k: count(j),
    o200k: count(j, "o200k_base"),
    descriptionCl100k: count(t.description),
  };
});

const sum = (rows, k) => rows.reduce((a, r) => a + r[k], 0);
const full = {
  tools: perTool.length,
  bytes: Buffer.byteLength(surfaceText, "utf8"),
  cl100k: count(surfaceText),
  o200k: count(surfaceText, "o200k_base"),
  chars4: Math.ceil(surfaceText.length / 4),
};

// lean profile = 4 tools (§4.5.0)
const leanNames = new Set(["context_boot", "context_page_in", "context_commit", "context_flag_dead_end"]);
const leanText = JSON.stringify({
  instructions,
  tools: surface.tools.filter((t) => leanNames.has(t.name)),
});
const lean = { tools: 4, cl100k: count(leanText), o200k: count(leanText, "o200k_base"), chars4: Math.ceil(leanText.length / 4) };

// Three ways to shrink the surface: shorter descriptions, one-line descriptions,
// and schemas with no descriptions at all (the absolute floor). The report needs
// all three to say whether the budget is reachable or impossible.
const oneLine = {
  context_boot: "Return the project head and a token-budgeted index of nodes.",
  context_page_in: "Fetch up to 12 nodes by path with status, freshness, edges, and constraints.",
  context_commit: "Write or update one knowledge node; verified requires evidence.",
  context_checkpoint: "Snapshot files and knowledge state as one atomic checkpoint.",
  context_rewind: "Restore an earlier checkpoint and record why the attempt failed.",
  context_fork: "Branch the project from a checkpoint without copying blobs.",
  context_flag_dead_end: "Record a failed approach so future sessions do not repeat it.",
};
const minimalText = JSON.stringify({
  instructions,
  tools: surface.tools.map((t) => ({ name: t.name, description: oneLine[t.name], inputSchema: t.inputSchema })),
});
const bareText = JSON.stringify({
  instructions,
  tools: surface.tools.map((t) => ({ name: t.name, description: "", inputSchema: t.inputSchema })),
});
const minimal = {
  cl100k: count(minimalText),
  o200k: count(minimalText, "o200k_base"),
  tools: 7,
  descriptionPolicy: "one sentence per tool (~13 tokens)",
};
const bare = {
  cl100k: count(bareText),
  o200k: count(bareText, "o200k_base"),
  tools: 7,
  descriptionPolicy: "empty strings — absolute floor for these input schemas",
};

// Reduced contract: advertise only required properties plus routing
// (project_id/branch). Defaults are documented, not schema. This is the shape
// Phase 1 would ship if the 1,200-token hard cap has to be met.
const ROUTING = new Set(["project_id", "branch"]);
const reducedTools = surface.tools.map((t) => {
  const required = new Set(t.inputSchema.required ?? []);
  const props = Object.entries(t.inputSchema.properties).filter(([k]) => required.has(k) || ROUTING.has(k));
  return {
    name: t.name,
    description: oneLine[t.name],
    inputSchema: { type: "object", properties: Object.fromEntries(props), required: [...required].filter((k) => k !== undefined), additionalProperties: false },
  };
});
const reducedText = JSON.stringify({ instructions, tools: reducedTools });
const reduced = {
  cl100k: count(reducedText),
  o200k: count(reducedText, "o200k_base"),
  tools: 7,
  descriptionPolicy: "one sentence per tool; required properties + project_id/branch only",
  propertyCount: reducedTools.reduce((a, t) => a + Object.keys(t.inputSchema.properties).length, 0),
};

// ── K5: 300-node boot index, flat vs grouped ───────────────────────────────
const r = rng(20261116);
const NODES = 300;
const MODULES = 12;
const kinds = ["spec", "impl", "test", "adr", "note"];
const nodes = [];
for (let i = 0; i < NODES; i++) {
  const mod = `backend/mod${String(i % MODULES).padStart(2, "0")}`;
  const kind = kinds[i % kinds.length];
  nodes.push({
    path: `${mod}/${kind}-${String(i).padStart(3, "0")}`,
    kind: "node",
    title: `${kind} ${i}: ${["auth", "billing", "sync", "cache", "queue"][i % 5]} ${["flow", "contract", "edge", "policy"][i % 4]}`,
    summary: `Decision ${i}: ${["tokens rotate hourly", "writes are idempotent", "retries cap at 3", "cache ttl is 60s", "queue is at-least-once"][i % 5]}.`,
    status: i % 7 === 0 ? "unverified" : "verified",
    freshness: i % 11 === 0 ? "stale" : "fresh",
    version: 1 + Math.floor(r() * 9),
  });
}

function flatIndex(list) {
  return JSON.stringify({
    mode: "flat",
    entries: list.map((n) => ({ path: n.path, kind: "node", title: n.title, summary: n.summary, status: n.status, freshness: n.freshness, version: n.version })),
    omitted_nodes: 0,
  });
}

function groupedIndex(list) {
  const groups = new Map();
  for (const n of list) {
    const dir = n.path.split("/").slice(0, 2).join("/");
    if (!groups.has(dir)) groups.set(dir, { count: 0, stale: 0, unverified: 0 });
    const g = groups.get(dir);
    g.count++;
    if (n.freshness === "stale") g.stale++;
    if (n.status === "unverified") g.unverified++;
  }
  const entries = [...groups.entries()]
    .sort()
    .slice(0, 12)
    .map(([dir, g], i) => ({
      path: dir,
      kind: "group",
      summary: `${g.count} nodes · ${g.stale} stale · ${g.unverified} unverified · ${["auth", "billing", "sync", "cache"][i % 4]} area`,
      count: g.count,
    }));
  return JSON.stringify({ mode: "grouped", entries, omitted_nodes: 0 });
}

// Real boot result also carries head, constraints, budgets, protocol. Those are
// fixed overhead the index budget is measured on top of, so both are reported.
const fixedBoot = {
  schema_version: 1,
  project: { id: "prj_01JBQ4M8Z6K2V9T3R5X7C1N0DA", slug: "chronos-ctx", name: "ChronosCtx" },
  branch: "main",
  head_checkpoint_id: "chk_01JBQ4M8Z6K2V9T3R5X7C1N0DB",
  head: {
    snapshot_hash: "sha256:9f2c", content_root: "sha256:1a7e", git_tree_hash: "4b825dc642cb6eb9a060e54bf899d69f",
    snapshot_kind: "combined", storage: "git", is_green_build: false, message: "checkpoint before refactor",
    created_at: "2026-11-16T00:00:00Z",
  },
  active_objective: "Ship the resumable checkpoint pipeline",
  root_summary: "Core state graph, shadow-git checkpointing, and MCP surface.",
  global_negative_constraints: [{ node_path: null, failed_approach: "use polling for file changes", failure_reason: "misses writes under burst load", severity: "caution", evidence_kind: "test_failure" }],
  workspace: { root: "/repo", drift: false, storage: "git", object_store: "home" },
  enforcement: { tier: "T2", hooks: ["SessionStart", "PreToolUse"], eviction: "enforced" },
  tool_profile: "full",
  budgets: { boot_tokens: 150, node_tokens: 500, page_in_tokens: 800, tool_surface_tokens: 900 },
  token_estimate: 0,
  estimator: "cl100k_base",
  paging_protocol: "page in only the paths needed for the current step; cite path@version; do not re-page a node whose version is unchanged; treat unverified as hypothesis; obey negative constraints; commit before risky edits and rewind after two failed attempts.",
  instructions: "Prefer small pages. Record dead ends.",
};
const withIndex = (indexText) => JSON.stringify({ ...fixedBoot, index: JSON.parse(indexText) });

const flatText = flatIndex(nodes);
const groupedText = groupedIndex(nodes);

// Variants, because a 200-token hard cap is only credible if some grouping
// actually fits it. Each is a real serializer, not a projection.
function groupIndex(list, { levels = 2, summaryWords = 0, maxGroups = 12 }) {
  const buckets = new Map();
  for (const n of list) {
    const parts = n.path.split("/");
    const key = parts.slice(0, levels).join("/");
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(n);
  }
  const entries = [...buckets.entries()].sort().slice(0, maxGroups).map(([key, items]) => {
    const e = { path: key, kind: "group", count: items.length };
    if (summaryWords > 0) {
      e.summary = items.slice(0, summaryWords).map((n) => n.title.split(" ")[0]).join(" ") + " area";
    }
    return e;
  });
  return JSON.stringify({ mode: "grouped", entries, omitted_nodes: list.length - entries.reduce((a, e) => a + e.count, 0) });
}

const variants = {
  "12 groups, one-line summary": groupedText,
  "12 groups, counts only": groupIndex(nodes, { levels: 2, summaryWords: 0, maxGroups: 12 }),
  "5 groups, counts only": groupIndex(nodes, { levels: 2, summaryWords: 0, maxGroups: 5 }),
  "3 top-level groups, counts only": groupIndex(nodes, { levels: 1, summaryWords: 0, maxGroups: 3 }),
  "20 groups, counts only": groupIndex(nodes, { levels: 2, summaryWords: 0, maxGroups: 20 }),
};
const variantTokens = Object.fromEntries(
  Object.entries(variants).map(([k, v]) => [k, { cl100k: count(v), entries: JSON.parse(v).entries.length }]),
);
const fitting = Object.entries(variantTokens).filter(([, v]) => v.cl100k <= 200).map(([k]) => k);

const boot = {
  nodes: NODES,
  indexOnly: {
    flat: { cl100k: count(flatText), o200k: count(flatText, "o200k_base") },
    grouped: { cl100k: count(groupedText), o200k: count(groupedText, "o200k_base") },
  },
  variants: variantTokens,
  variantsFitting200: fitting,
  withFixedOverhead: {
    flat: { cl100k: count(withIndex(flatText)) },
    grouped: { cl100k: count(withIndex(groupedText)) },
  },
};

// ── K6: 8-turn net-token model ─────────────────────────────────────────────
// This is a model, not a transcript from a live harness: Phase 0 has no working
// agent. Every assumption is a named constant so the verdict can be recomputed.
const scenario = {
  turns: 8,
  nodesReadPerTurn: 4,
  nodeTokensMean: 380,          // within the 500-token node budget
  baselineSystemTokens: 300,    // harness system prompt
  baselineToolOverheadPerTurn: 60,
  chronosSystemTokens: 300,
  bootIndexTokens: boot.indexOnly.grouped.cl100k,
  capsuleTokens: 130,           // rehydration capsule on turns that rewind/compact
  capsuleTurns: 3,
  outputTokensPerTurn: 400,     // assistant reasoning + edits, identical both ways
};

// Baseline: a stateless API call re-sends the whole prior transcript each turn,
// so every previously read node is paid for again.
let baselineIn = 0;
let readSoFar = 0;
for (let t = 1; t <= scenario.turns; t++) {
  readSoFar += scenario.nodesReadPerTurn * scenario.nodeTokensMean;
  baselineIn += scenario.baselineSystemTokens + scenario.baselineToolOverheadPerTurn * t + readSoFar;
}

// ChronosCtx: the stable prefix is the boot index (150) + system; each node is
// paid for once when paged in; a capsule is added on compaction turns.
const chronosPages = scenario.turns * scenario.nodesReadPerTurn * scenario.nodeTokensMean;
const chronosIn = scenario.turns * (scenario.chronosSystemTokens + scenario.bootIndexTokens)
  + chronosPages
  + scenario.capsuleTurns * scenario.capsuleTokens;

const baselineOut = scenario.turns * scenario.outputTokensPerTurn;
const chronosOut = baselineOut;

const net = {
  baseline: { input: baselineIn, output: baselineOut, total: baselineIn + baselineOut },
  chronos: { input: chronosIn, output: chronosOut, total: chronosIn + chronosOut },
  reductionPct: (1 - (chronosIn + chronosOut) / (baselineIn + baselineOut)) * 100,
};

// Sensitivity: prompt caching bills a repeated stable prefix at ~10% of input.
// This is NOT part of K6 (which is raw net tokens) but it is the honest picture
// of what a provider charges, and the roadmap claims cost savings in public.
const CACHE_READ = 0.1;
const cacheAdjusted = {
  baseline: baselineIn - (baselineIn - scenario.turns * scenario.baselineSystemTokens) * (1 - CACHE_READ) + baselineOut,
  chronos: chronosIn - (chronosIn - (chronosPages + scenario.capsuleTurns * scenario.capsuleTokens)) * (1 - CACHE_READ) + chronosOut,
};
cacheAdjusted.reductionPct = (1 - cacheAdjusted.chronos / cacheAdjusted.baseline) * 100;

writeJson(OUT, {
  gate: "0.4/0.5/0.6",
  title: "Tool-surface, boot-index, and net-token model",
  estimator: "js-tiktoken 1.0.21 (cl100k_base, o200k_base)",
  surface: { full, lean, minimal, bare, reduced, perTool, target: { cl100k_target: 900, cl100k_hard: 1200 } },
  bootIndex: boot,
  netTokens: { assumptions: scenario, ...net, cacheAdjusted, cacheReadFraction: CACHE_READ },
  surfaceJson: surfaceText,
});
console.log("[tokens] tool surface  cl100k", full.cl100k, "| o200k", full.o200k, "| target 900 / hard 1200");
console.log("[tokens] lean          cl100k", lean.cl100k, "| minimal", minimal.cl100k, "| bare", bare.cl100k, "| reduced", reduced.cl100k);
console.log("[tokens] boot index    grouped", boot.indexOnly.grouped.cl100k, "| flat", boot.indexOnly.flat.cl100k, "| target 200");
for (const [k, v] of Object.entries(boot.variants)) console.log(`[tokens]   ${k.padEnd(32)} ${String(v.cl100k).padStart(4)} tok  (${v.entries} entries)`);
console.log("[tokens] net reduction", net.reductionPct.toFixed(1) + "%", "| cache-adjusted", cacheAdjusted.reductionPct.toFixed(1) + "%");
console.log("[tokens] wrote", OUT);
