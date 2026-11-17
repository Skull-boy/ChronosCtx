import { describe, expect, it } from "vitest";
import {
  LEAN_SURFACE_CAP,
  MCP_INSTRUCTIONS,
  measureSurface,
  profileTools,
  TOOLS,
} from "./tools.js";

describe("tool surface (gate 1.12)", () => {
  it("ships seven tools and a lean profile of four", () => {
    expect(TOOLS.size).toBe(7);
    expect(profileTools("full")).toHaveLength(7);
    expect(profileTools("lean")).toHaveLength(4);
  });

  it("keeps the full reduced contract within the target and hard cap", () => {
    const measurement = measureSurface("full");
    expect(measurement.total_tokens).toBeLessThanOrEqual(measurement.hard_cap);
    expect(measurement.total_tokens).toBeLessThanOrEqual(measurement.target);
    expect(measurement.within_hard).toBe(true);
    expect(measurement.within_target).toBe(true);
  });

  it("keeps the lean profile under its own cap", () => {
    const measurement = measureSurface("lean");
    expect(measurement.total_tokens).toBeLessThanOrEqual(LEAN_SURFACE_CAP);
  });

  it("includes the server instructions in the measured payload", () => {
    const measurement = measureSurface("full");
    expect(measurement.instructions_tokens).toBeGreaterThan(0);
    expect(measurement.total_tokens).toBeGreaterThan(measurement.instructions_tokens);
    expect(MCP_INSTRUCTIONS.length).toBeGreaterThan(0);
  });

  it("reports per-tool cost and is deterministic", () => {
    const first = measureSurface("full");
    const second = measureSurface("full");
    expect(first).toEqual(second);
    expect(first.per_tool).toHaveLength(7);
    for (const tool of first.per_tool) expect(tool.tokens).toBeGreaterThan(0);
  });

  it("requires the properties that cannot be defaulted", () => {
    expect(TOOLS.get("context_page_in")?.inputSchema.required).toEqual(["paths"]);
    expect(TOOLS.get("context_commit")?.inputSchema.required).toEqual([
      "path",
      "title",
      "summary",
      "content",
    ]);
    expect(TOOLS.get("context_rewind")?.inputSchema.required).toEqual([
      "to_checkpoint_id",
      "failed_approach",
      "failure_reason",
    ]);
  });
});
