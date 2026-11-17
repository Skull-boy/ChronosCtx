import { estimate, type TokenAccounting } from "@chronos-ctx/shared-types";
import { describe, expect, it } from "vitest";
import {
  cutToTokens,
  fitToBudget,
  measureText,
  renderEnvelope,
  tokenAccounting,
} from "./budget.js";

const envelope = (tokens: TokenAccounting): string => JSON.stringify({ schema_version: 1, tokens });

describe("tokenAccounting", () => {
  it("sums the three components", () => {
    expect(tokenAccounting(10, 20, 5)).toEqual({
      content: 10,
      envelope: 20,
      schema: 5,
      total: 35,
    });
  });
});

describe("renderEnvelope", () => {
  it("reaches a fixed point where the reported envelope size is the real size", () => {
    const rendered = renderEnvelope(envelope, 500, 50);
    expect(estimate(rendered.text)).toBe(rendered.tokens);
    const parsed = JSON.parse(rendered.text) as { tokens: TokenAccounting };
    expect(parsed.tokens.content).toBe(500);
    expect(parsed.tokens.schema).toBe(50);
    expect(parsed.tokens.envelope).toBe(rendered.tokens);
    expect(parsed.tokens.total).toBe(500 + rendered.tokens + 50);
  });
});

describe("cutToTokens", () => {
  it("returns the input when it already fits", () => {
    expect(cutToTokens("short", 100)).toBe("short");
  });

  it("cuts at a sentence boundary rather than mid-word", () => {
    const text = "First sentence is here. Second sentence is much longer and should be removed.";
    const cut = cutToTokens(text, 12);
    expect(cut).not.toBeNull();
    expect(measureText(cut as string)).toBeLessThanOrEqual(12);
    expect(cut?.endsWith(".")).toBe(true);
  });

  it("never exceeds the budget", () => {
    const text = "a".repeat(1000);
    const cut = cutToTokens(text, 10);
    expect(cut === null || measureText(cut) <= 10).toBe(true);
  });

  it("returns null when there is no room", () => {
    expect(cutToTokens("anything", 0)).toBeNull();
  });
});

describe("fitToBudget", () => {
  const items = ["one", "two", "three", "four", "five"];

  it("keeps everything when it fits and reports no loss", () => {
    const result = fitToBudget({
      items,
      render: (kept) => kept.join("\n"),
      envelope,
      schemaTokens: 0,
      maxTokens: 1000,
    });
    expect(result.items).toEqual(items);
    expect(result.truncated).toBe(false);
    expect(result.omittedTokens).toBe(0);
    expect(result.tokens.total).toBeLessThanOrEqual(1000);
  });

  it("drops whole items from the tail and reports the loss", () => {
    const full = items.join("\n");
    const budget = renderEnvelope(envelope, 0, 0).tokens + 3;
    const result = fitToBudget({
      items,
      render: (kept) => kept.join("\n"),
      envelope,
      schemaTokens: 0,
      maxTokens: budget,
    });
    expect(result.items.length).toBeLessThan(items.length);
    expect(result.truncated).toBe(true);
    expect(result.omittedTokens).toBe(Math.max(0, measureText(full) - result.tokens.content));
    expect(result.tokens.total).toBeLessThanOrEqual(budget);
    expect(result.fits).toBe(true);
  });

  it("reports when the envelope alone cannot fit", () => {
    const result = fitToBudget({
      items,
      render: (kept) => kept.join("\n"),
      envelope,
      schemaTokens: 0,
      maxTokens: 5,
    });
    expect(result.items).toEqual([]);
    expect(result.fits).toBe(false);
    expect(result.truncated).toBe(true);
  });

  it("counts the schema share against the budget", () => {
    const result = fitToBudget({
      items,
      render: (kept) => kept.join("\n"),
      envelope,
      schemaTokens: 50,
      maxTokens: 70,
    });
    expect(result.tokens.total).toBeLessThanOrEqual(70);
    expect(result.tokens.schema).toBe(50);
  });

  it("uses cutLast when a single item is over budget", () => {
    const long = "A sentence that is long enough to need cutting. ".repeat(10);
    const result = fitToBudget({
      items: [long],
      render: (kept) => kept.join(""),
      envelope,
      schemaTokens: 0,
      maxTokens: 40,
      cutLast: (item, budget) => cutToTokens(item, budget),
    });
    expect(result.items).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.tokens.total).toBeLessThanOrEqual(40);
  });

  it("is deterministic for identical input", () => {
    const run = () =>
      fitToBudget({
        items,
        render: (kept) => kept.join("\n"),
        envelope,
        schemaTokens: 5,
        maxTokens: 15,
      });
    expect(run()).toEqual(run());
  });
});
