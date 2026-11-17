/**
 * Token budgets and estimator accounting (§4.1).
 *
 * The default estimator is `ceil(chars / 4)` tagged `chars4`; a real tokenizer
 * reports `cl100k_base` when available. Every response accounts for content,
 * envelope, and schema separately so serialization overhead cannot hide.
 */

export type Estimator = "chars4" | "cl100k_base";

export interface TextEstimator {
  readonly id: Estimator;
  count(text: string): number;
}

export const chars4Estimator: TextEstimator = {
  id: "chars4",
  count: (text: string): number => Math.ceil(Array.from(text).length / 4),
};
export function estimate(text: string, estimator: Estimator = "chars4"): number {
  if (estimator === "chars4") return chars4Estimator.count(text);
  throw new RangeError("cl100k_base requires a tokenizer implementation to be registered");
}

export interface Budget {
  readonly default: number;
  readonly hard: number;
}

export type BudgetName =
  | "boot"
  | "node"
  | "page_in"
  | "capsule"
  | "negative_constraints"
  | "tool_surface"
  | "mcp_instructions";

export type BudgetTable = Readonly<Record<BudgetName, Budget>>;

export const BUDGETS: BudgetTable = {
  boot: { default: 150, hard: 200 },
  node: { default: 500, hard: 800 },
  page_in: { default: 800, hard: 1200 },
  capsule: { default: 400, hard: 500 },
  negative_constraints: { default: 5, hard: 10 },
  tool_surface: { default: 900, hard: 1200 },
  mcp_instructions: { default: 300, hard: 400 },
};

export interface TokenAccounting {
  content: number;
  envelope: number;
  schema: number;
  total: number;
}

export function accounting(content: number, envelope: number, schema = 0): TokenAccounting {
  return { content, envelope, schema, total: content + envelope + schema };
}

export interface BudgetCheck {
  readonly ok: boolean;
  readonly overBy: number;
  readonly cap: number;
}

export function checkBudget(total: number, budget: Budget): BudgetCheck {
  return {
    ok: total <= budget.hard,
    overBy: Math.max(0, total - budget.hard),
    cap: budget.hard,
  };
}
