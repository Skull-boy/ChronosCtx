import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BootService } from "./boot.js";
import { type PagingFixture, seedPagingFixture } from "./paging.fixture.js";

const DAEMON = { version: "test", pid: 1 };

let fixture: PagingFixture;
let boot: BootService;

beforeAll(async () => {
  fixture = await seedPagingFixture();
  boot = new BootService({ db: fixture.db });
}, 180_000);

afterAll(() => {
  fixture.cleanup();
});

function payload(overrides: Record<string, unknown> = {}) {
  return boot.boot({
    projectId: fixture.projectId,
    daemon: DAEMON,
    ...overrides,
  });
}

describe("boot index (gate 1.4)", () => {
  it("fits a 300-node project in the 150-token default", async () => {
    const result = await payload();
    expect(result.counts.nodes).toBe(300);
    expect(result.counts.verified).toBe(42);
    expect(result.counts.unverified).toBe(258);
    expect(result.counts.deprecated).toBe(0);
    expect(result.tokens.total).toBeLessThanOrEqual(150);
    expect(result.text).toContain("CHRONOS BOOT v1");
    expect(result.text).toContain("groups:");
    expect(result.groups).toHaveLength(6);
    expect(result.checkpointId).toBe(fixture.checkpointId);
  });

  it("never exceeds an explicit hard budget of 200", async () => {
    const result = await payload({ maxTokens: 9999 });
    expect(result.tokens.total).toBeLessThanOrEqual(200);
  });

  it("is deterministic for the same project and daemon identity", async () => {
    const first = await payload();
    const second = await payload();
    expect(first.text).toBe(second.text);
    expect(first.tokens).toEqual(second.tokens);
    expect(first.envelope).toEqual(second.envelope);
  });

  it("uses counts-only groups by default and summaries only on request", async () => {
    const counts = await payload();
    expect(counts.includeSummaries).toBe(false);
    expect(counts.text).not.toContain("@v");

    const withSummaries = await payload({ includeSummaries: true, maxTokens: 200 });
    expect(withSummaries.includeSummaries).toBe(true);
    expect(withSummaries.tokens.total).toBeLessThanOrEqual(200);
    if (withSummaries.text.includes("@v")) {
      expect(withSummaries.truncated).toBe(true);
    }
  });

  it("drops optional sections under pressure and says what was lost", async () => {
    const result = await payload({ maxTokens: 80 });
    expect(result.tokens.total).toBeLessThanOrEqual(80);
    expect(result.truncated).toBe(true);
    expect(result.warnings.some((warning) => warning.code === "TRUNCATED")).toBe(true);
    expect(result.text).not.toContain("resume:");
  });

  it("reports an impossible budget instead of pretending it fit", async () => {
    const result = await payload({ maxTokens: 50 });
    expect(result.fits).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe("");
  });

  it("reports project-not-found rather than an empty index", async () => {
    await expect(boot.boot({ projectId: "prj_missing", daemon: DAEMON })).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
    });
  });
});
