import { describe, expect, it } from "vitest";
import {
  changedPaths,
  computeFreshness,
  diffTrees,
  freshnessMarker,
  isCovered,
  type TreeState,
} from "./freshness.js";

function tree(entries: Record<string, string>): TreeState {
  return new Map(Object.entries(entries));
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PATH_POOL = [
  "src/a.ts",
  "src/b.ts",
  "src/nested/c.ts",
  "docs/x.md",
  "docs/y.md",
  "api/routes.ts",
  "db/schema.sql",
  "tests/t.ts",
];

const COVER_POOL = ["src", "src/a.ts", "docs", "api", "db/schema.sql", "tests/t.ts"];

function pick<T>(rng: () => number, pool: readonly T[]): T {
  return pool[Math.floor(rng() * pool.length)] as T;
}

function randomTree(rng: () => number): Map<string, string> {
  const result = new Map<string, string>();
  for (const path of PATH_POOL) {
    if (rng() < 0.6) result.set(path, `h${Math.floor(rng() * 3)}`);
  }
  return result;
}

function randomCovered(rng: () => number): string[] {
  const result: string[] = [];
  for (const path of COVER_POOL) {
    if (rng() < 0.35) result.push(path);
  }
  return result;
}

function mutate(rng: () => number, before: TreeState): TreeState {
  const after = new Map(before);
  const operations = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < operations; i += 1) {
    const path = pick(rng, PATH_POOL);
    if (rng() < 0.25) after.delete(path);
    else after.set(path, `h${Math.floor(rng() * 4)}`);
  }
  return after;
}

describe("diffTrees", () => {
  it("classifies added, removed and modified paths", () => {
    const before = tree({ "a.ts": "1", "b.ts": "2", "c.ts": "3" });
    const after = tree({ "a.ts": "1", "b.ts": "9", "d.ts": "4" });
    expect(diffTrees(before, after)).toEqual({
      added: ["d.ts"],
      removed: ["c.ts"],
      modified: ["b.ts"],
    });
  });

  it("is empty for equal trees", () => {
    const value = tree({ "a.ts": "1" });
    expect(changedPaths(diffTrees(value, value))).toEqual([]);
  });
});

describe("isCovered", () => {
  it("covers a file and its descendants, not a string prefix", () => {
    expect(isCovered("src/a.ts", ["src"])).toBe(true);
    expect(isCovered("src", ["src"])).toBe(true);
    expect(isCovered("srcx/a.ts", ["src"])).toBe(false);
    expect(isCovered("src/a.ts", ["src/"])).toBe(true);
  });
});

describe("computeFreshness", () => {
  const evidence = tree({ "src/a.ts": "1", "docs/x.md": "1" });

  it("is fresh when no covered path changed", () => {
    const current = tree({ "src/a.ts": "1", "docs/x.md": "2" });
    const result = computeFreshness({
      evidenceTree: evidence,
      currentTree: current,
      coveredPaths: ["src"],
    });
    expect(result.value).toBe("fresh");
    expect(result.changedCoveredPaths).toEqual([]);
  });

  it("is stale when a covered file changed", () => {
    const current = tree({ "src/a.ts": "2", "docs/x.md": "1" });
    const result = computeFreshness({
      evidenceTree: evidence,
      currentTree: current,
      coveredPaths: ["src/a.ts"],
    });
    expect(result.value).toBe("stale");
    expect(result.changedCoveredPaths).toEqual(["src/a.ts"]);
    expect(result.reason).toBe("tree changed in 1 covered path");
  });

  it("treats an added or removed covered path as a change", () => {
    const added = tree({ "src/a.ts": "1", "docs/x.md": "1", "src/new.ts": "1" });
    expect(
      computeFreshness({
        evidenceTree: evidence,
        currentTree: added,
        coveredPaths: ["src"],
      }).value,
    ).toBe("stale");

    const removed = tree({ "docs/x.md": "1" });
    expect(
      computeFreshness({
        evidenceTree: evidence,
        currentTree: removed,
        coveredPaths: ["src"],
      }).value,
    ).toBe("stale");
  });

  it("is unknown without evidence, without a workspace, or without coverage", () => {
    expect(
      computeFreshness({ evidenceTree: null, currentTree: evidence, coveredPaths: ["src"] }).value,
    ).toBe("unknown");
    expect(
      computeFreshness({ evidenceTree: evidence, currentTree: null, coveredPaths: ["src"] }).value,
    ).toBe("unknown");
    expect(
      computeFreshness({ evidenceTree: evidence, currentTree: evidence, coveredPaths: [] }).value,
    ).toBe("unknown");
  });

  it("renders the marker the daemon must emit", () => {
    expect(
      freshnessMarker({
        value: "fresh",
        reason: "no covered path changed",
        changedCoveredPaths: [],
      }),
    ).toBe("[fresh]");
    expect(
      freshnessMarker({
        value: "stale",
        reason: "tree changed in 2 covered paths",
        changedCoveredPaths: [],
      }),
    ).toBe("[stale: tree changed in 2 covered paths]");
    expect(
      freshnessMarker({
        value: "unknown",
        reason: "no workspace attached",
        changedCoveredPaths: [],
      }),
    ).toBe("[unknown: no workspace attached]");
  });
});

describe("freshness invariants (gate 1.8)", () => {
  it("5,000 generated histories produce zero false-fresh nodes", () => {
    const rng = mulberry32(20261117);
    let fresh = 0;
    let stale = 0;
    let unknown = 0;

    for (let i = 0; i < 5000; i += 1) {
      const evidenceTree = randomTree(rng);
      const currentTree = mutate(rng, evidenceTree);
      const coveredPaths = randomCovered(rng);

      const result = computeFreshness({ evidenceTree, currentTree, coveredPaths });
      const changed = changedPaths(diffTrees(evidenceTree, currentTree));
      const touched = changed.filter((path) => isCovered(path, coveredPaths));

      if (coveredPaths.length === 0) {
        unknown += 1;
        expect(result.value).toBe("unknown");
        continue;
      }

      if (result.value === "fresh") {
        fresh += 1;
        // The definition of the gate: no changed path may be covered.
        expect(touched).toEqual([]);
      } else {
        stale += 1;
        expect(result.value).toBe("stale");
        expect(touched.length).toBeGreaterThan(0);
        expect(result.changedCoveredPaths).toEqual(touched);
      }

      // Monotonicity: adding coverage cannot turn stale into fresh.
      const wider = [...coveredPaths, ...COVER_POOL.filter((path) => !coveredPaths.includes(path))];
      const widerResult = computeFreshness({
        evidenceTree,
        currentTree,
        coveredPaths: wider,
      });
      if (result.value === "stale") expect(widerResult.value).toBe("stale");

      // An uncovered change cannot invalidate a fresh result.
      if (result.value === "fresh") {
        const extra = new Map(currentTree);
        extra.set("vendor/uncovered.txt", `h${i}`);
        const withUncovered = computeFreshness({
          evidenceTree,
          currentTree: extra,
          coveredPaths,
        });
        expect(withUncovered.value).toBe("fresh");
      }
    }

    expect(fresh).toBeGreaterThan(500);
    expect(stale).toBeGreaterThan(500);
    expect(unknown).toBeGreaterThan(100);
    expect(fresh + stale + unknown).toBe(5000);
  });
});
