import { describe, expect, it } from "vitest";
import { decideStatus } from "./gate.js";

const previous = {
  status: "verified" as const,
  contentHash: "hash-1",
  verificationEventId: "vev_1",
  verifiedTreeHash: "tree-1",
  createdAt: 1000,
};

const evidence = {
  id: "vev_2",
  kind: "test_pass" as const,
  exitCode: 0,
  createdAt: 2000,
  treeHash: "tree-2",
};

function decide(overrides: Partial<Parameters<typeof decideStatus>[0]> = {}) {
  return decideStatus({
    requested: "unverified",
    previous: null,
    newContentHash: "hash-1",
    sourceSurface: "opencode-cli",
    evidence: null,
    allowAgentOverride: false,
    ...overrides,
  });
}

describe("decideStatus", () => {
  it("defaults a new node to unverified", () => {
    const decision = decide();
    expect(decision.status).toBe("unverified");
    expect(decision.verificationEventId).toBeNull();
    expect(decision.demoted).toBe(false);
  });

  it("inherits trust and evidence for an identical-text re-commit", () => {
    const decision = decide({ previous });
    expect(decision.status).toBe("verified");
    expect(decision.verificationEventId).toBe("vev_1");
    expect(decision.verifiedTreeHash).toBe("tree-1");
  });

  it("demotes on any text change, including a title or summary edit", () => {
    const decision = decide({ previous, newContentHash: "hash-2" });
    expect(decision.status).toBe("unverified");
    expect(decision.demoted).toBe(true);
    expect(decision.verificationEventId).toBeNull();
  });

  it("refuses an unprovable inherited trust", () => {
    expect(() => decide({ previous: { ...previous, verificationEventId: null } })).toThrowError(
      /unprovable trust/u,
    );
  });

  it("refuses verified from a web surface before looking at evidence", () => {
    expect(() =>
      decide({ requested: "verified", sourceSurface: "gemini-web", evidence }),
    ).toThrowError(/cannot promote/u);
  });

  it("refuses verified without evidence", () => {
    expect(() => decide({ requested: "verified" })).toThrowError(/requires verification evidence/u);
  });

  it("refuses a non-promoting kind and a failing exit code", () => {
    expect(() =>
      decide({ requested: "verified", evidence: { ...evidence, kind: "lint_pass" } }),
    ).toThrowError(/cannot promote a node/u);
    expect(() =>
      decide({ requested: "verified", evidence: { ...evidence, exitCode: 1 } }),
    ).toThrowError(/only 0 can promote/u);
  });

  it("refuses stale evidence for changed content unless overridden", () => {
    const stale = { ...evidence, createdAt: 1000 };
    expect(() =>
      decide({ requested: "verified", previous, newContentHash: "hash-2", evidence: stale }),
    ).toThrowError(/predates the previous version/u);

    const overridden = decide({
      requested: "verified",
      previous,
      newContentHash: "hash-2",
      evidence: stale,
      allowAgentOverride: true,
    });
    expect(overridden.status).toBe("verified");
  });

  it("accepts fresh evidence for changed content", () => {
    const decision = decide({
      requested: "verified",
      previous,
      newContentHash: "hash-2",
      evidence: { ...evidence, createdAt: 3000 },
    });
    expect(decision.status).toBe("verified");
    expect(decision.verificationEventId).toBe("vev_2");
    expect(decision.verifiedTreeHash).toBe("tree-2");
  });

  it("allows deprecation without evidence and clears the linkage", () => {
    const decision = decide({ previous, requested: "deprecated" });
    expect(decision.status).toBe("deprecated");
    expect(decision.verificationEventId).toBeNull();
    expect(decision.demoted).toBe(false);
  });
});
