import { BUDGETS, estimate } from "@chronos-ctx/shared-types";

/**
 * The measured tool surface (ADR-0006, gate 1.12).
 *
 * This is the **reduced** contract: names, types, required fields, defaults and
 * the enums a model must see to call correctly. Numeric bounds, max lengths,
 * per-property descriptions and rarely used options stay in the full schema
 * (`chronos://schema/full`) because Phase 0 measured what they cost: the full
 * surface was 1,795 tokens, and even with every description deleted it was
 * 1,444. A model pays the surface on every request.
 *
 * The full schema still validates server-side; omitting a bound here changes
 * what the model is told, never what the daemon accepts. Phase 2 generates the
 * zod validators from the full schema, and this measurement remains the gate.
 */

export type ToolProfile = "full" | "lean";

type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
};

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

const SELECTORS = {
  project_id: { type: "string" },
  branch: { type: "string", default: "main" },
} as const;

const TOOL_LIST: readonly ToolDefinition[] = [
  {
    name: "context_boot",
    description: "Bounded project index: objective, counts, groups, constraints.",
    inputSchema: {
      type: "object",
      properties: {
        ...SELECTORS,
        max_tokens: { type: "integer", default: 150 },
        include_summaries: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "context_page_in",
    description: "Page in node detail within a token budget, with status and freshness.",
    inputSchema: {
      type: "object",
      properties: {
        ...SELECTORS,
        paths: { type: "array", items: { type: "string" }, maxItems: 12 },
        max_tokens: { type: "integer", default: 1200 },
        include_negative_constraints: { type: "boolean", default: true },
        expand: { type: "array", items: { type: "string" }, maxItems: 3 },
        format: { type: "string", enum: ["markdown", "json"], default: "markdown" },
      },
      required: ["paths"],
    },
  },
  {
    name: "context_commit",
    description: "Write a versioned node. Verified requires evidence; any text edit demotes.",
    inputSchema: {
      type: "object",
      properties: {
        ...SELECTORS,
        path: { type: "string" },
        title: { type: "string" },
        summary: { type: "string" },
        content: { type: "string" },
        status: {
          type: "string",
          enum: ["unverified", "verified", "deprecated"],
          default: "unverified",
        },
        expected_version: { type: "integer" },
        verification_event_id: { type: "string" },
      },
      required: ["path", "title", "summary", "content"],
    },
  },
  {
    name: "context_checkpoint",
    description: "Atomically snapshot reasoning state and the workspace tree.",
    inputSchema: {
      type: "object",
      properties: {
        ...SELECTORS,
        message: { type: "string" },
        kind: { type: "string", enum: ["manual", "auto_commit", "watch_green"], default: "manual" },
        is_green_build: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "context_rewind",
    description: "Restore files and state to a checkpoint; drift is refused.",
    inputSchema: {
      type: "object",
      properties: {
        ...SELECTORS,
        to_checkpoint_id: { type: "string" },
        failed_approach: { type: "string" },
        failure_reason: { type: "string" },
        force: { type: "boolean", default: false },
        dry_run: { type: "boolean", default: false },
      },
      required: ["to_checkpoint_id", "failed_approach", "failure_reason"],
    },
  },
  {
    name: "context_fork",
    description: "Create a hypothesis branch sharing the project version sequence.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        branch: { type: "string" },
        from_branch: { type: "string", default: "main" },
        from_checkpoint_id: { type: "string" },
        copy_unverified_nodes: { type: "boolean", default: true },
      },
      required: ["branch"],
    },
  },
  {
    name: "context_flag_dead_end",
    description: "Record a failed approach so it is not retried.",
    inputSchema: {
      type: "object",
      properties: {
        ...SELECTORS,
        node_path: { type: "string" },
        failed_approach: { type: "string" },
        failure_reason: { type: "string" },
        severity: { type: "string", enum: ["caution", "blocking"], default: "caution" },
      },
      required: ["failed_approach", "failure_reason"],
    },
  },
];

export const TOOLS: ReadonlyMap<string, ToolDefinition> = new Map(
  TOOL_LIST.map((tool) => [tool.name, tool]),
);

export const LEAN_TOOL_NAMES = [
  "context_boot",
  "context_page_in",
  "context_commit",
  "context_checkpoint",
] as const;

export const MCP_INSTRUCTIONS =
  "Page in only what the next step needs; commit with evidence; never claim verified without evidence; rewind after repeated failure.";

/** Lean profile ceiling from §1.5. */
export const LEAN_SURFACE_CAP = 600;

export function profileTools(profile: ToolProfile): ToolDefinition[] {
  if (profile === "full") return [...TOOL_LIST];
  return LEAN_TOOL_NAMES.map((name) => {
    const tool = TOOLS.get(name);
    if (tool === undefined) throw new Error(`lean profile references unknown tool ${name}`);
    return tool;
  });
}

export interface ToolSurfaceMeasurement {
  profile: ToolProfile;
  tools: number;
  schema_tokens: number;
  instructions_tokens: number;
  total_tokens: number;
  hard_cap: number;
  target: number;
  lean_cap: number;
  within_hard: boolean;
  within_target: boolean;
  per_tool: Array<{ name: string; tokens: number }>;
}

export function measureSurface(profile: ToolProfile = "full"): ToolSurfaceMeasurement {
  const tools = profileTools(profile);

  // Measure the payload a client receives, not the sum of parts: braces,
  // commas and the instructions wrapper are real tokens too.
  const payload = JSON.stringify({ instructions: MCP_INSTRUCTIONS, tools });
  const total = estimate(payload);
  const instructions = estimate(MCP_INSTRUCTIONS);
  const perTool = tools.map((tool) => ({
    name: tool.name,
    tokens: estimate(JSON.stringify(tool)),
  }));

  return {
    profile,
    tools: tools.length,
    schema_tokens: total - instructions,
    instructions_tokens: instructions,
    total_tokens: total,
    hard_cap: BUDGETS.tool_surface.hard,
    target: BUDGETS.tool_surface.default,
    lean_cap: LEAN_SURFACE_CAP,
    within_hard: total <= BUDGETS.tool_surface.hard,
    within_target: total <= BUDGETS.tool_surface.default,
    per_tool: perTool,
  };
}
