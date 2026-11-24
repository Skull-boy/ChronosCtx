import { describe, expect, it } from "vitest";
import {
  accounting,
  BUDGETS,
  type BudgetName,
  chars4Estimator,
  checkBudget,
  estimate,
} from "./tokens.js";

describe("chars4 estimator", () => {
  it("rounds code points up by four characters", () => {
    expect(chars4Estimator.id).toBe("chars4");
    expect(chars4Estimator.count("")).toBe(0);
    expect(chars4Estimator.count("a")).toBe(1);
    expect(chars4Estimator.count("abcd")).toBe(1);
    expect(chars4Estimator.count("abcde")).toBe(2);
    // Array.from counts code points, not UTF-16 code units.
    expect(chars4Estimator.count("😀")).toBe(1);
    expect(chars4Estimator.count("😀😀")).toBe(1);
    expect(chars4Estimator.count("😀😀😀😀😀")).toBe(2);
  });

  it("is the default estimator and rejects an unregistered tokenizer", () => {
    expect(estimate("abcdefgh")).toBe(2);
    expect(estimate("abcdefgh", "chars4")).toBe(2);
    expect(() => estimate("abcdefgh", "cl100k_base")).toThrow(RangeError);
    expect(() => estimate("abcdefgh", "cl100k_base")).toThrow(/tokenizer/u);
  });
});

describe("budget table", () => {
  it("keeps every default at or below its hard cap", () => {
    const names = Object.keys(BUDGETS) as BudgetName[];
    expect(names).toHaveLength(7);
    for (const name of names) {
      const budget = BUDGETS[name];
      expect(budget.default).toBeLessThanOrEqual(budget.hard);
    }
  });

  it("pins the published caps", () => {
    expect(BUDGETS.boot).toEqual({ default: 150, hard: 200 });
    expect(BUDGETS.node).toEqual({ default: 500, hard: 800 });
    expect(BUDGETS.page_in).toEqual({ default: 800, hard: 1200 });
    expect(BUDGETS.capsule).toEqual({ default: 400, hard: 500 });
    expect(BUDGETS.negative_constraints).toEqual({ default: 5, hard: 10 });
    expect(BUDGETS.tool_surface).toEqual({ default: 900, hard: 1200 });
    expect(BUDGETS.mcp_instructions).toEqual({ default: 300, hard: 400 });
  });
});

describe("accounting", () => {
  it("sums content, envelope and schema", () => {
    expect(accounting(10, 2)).toEqual({ content: 10, envelope: 2, schema: 0, total: 12 });
    expect(accounting(10, 2, 3)).toEqual({ content: 10, envelope: 2, schema: 3, total: 15 });
  });

  it("reports over-budget amounts against the hard cap, never the default", () => {
    const budget = { default: 100, hard: 120 };
    expect(checkBudget(50, budget)).toEqual({ ok: true, overBy: 0, cap: 120 });
    expect(checkBudget(120, budget)).toEqual({ ok: true, overBy: 0, cap: 120 });
    expect(checkBudget(121, budget)).toEqual({ ok: false, overBy: 1, cap: 120 });
    expect(checkBudget(500, budget)).toEqual({ ok: false, overBy: 380, cap: 120 });
  });
});
