import { describe, expect, it } from "vitest";
import { contentHash, contentRoot, renderHash, snapshotHash } from "./hash.js";
import { decodeSnapshotBody, encodeSnapshotBody, parseSnapshotText } from "./snapshot.js";

describe("contentHash", () => {
  it("is deterministic", () => {
    const a = contentHash({ title: "T", summary: "S", content: "C" });
    const b = contentHash({ title: "T", summary: "S", content: "C" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("changes for content, title or summary edits", () => {
    const base = { title: "T", summary: "S", content: "C" };
    expect(contentHash({ ...base, content: "C2" })).not.toBe(contentHash(base));
    expect(contentHash({ ...base, title: "T2" })).not.toBe(contentHash(base));
    expect(contentHash({ ...base, summary: "S2" })).not.toBe(contentHash(base));
  });
});

describe("snapshot identities", () => {
  const a = { path: "b/two", versionId: "ver_2" };
  const b = { path: "a/one", versionId: "ver_1" };

  it("sorts entries so insertion order does not matter", () => {
    expect(snapshotHash([a, b])).toBe(snapshotHash([b, a]));
  });

  it("uses a versioned prefix", () => {
    expect(snapshotHash([])).toBe(snapshotHash([]));
    expect(snapshotHash([a])).not.toBe(contentRoot([{ path: "b/two", contentHash: "h" }]));
  });

  it("content_root is stable across different version ids with equal content", () => {
    const localOne = contentRoot([{ path: "a", contentHash: "h1" }]);
    const localTwo = contentRoot([{ path: "a", contentHash: "h1" }]);
    expect(localOne).toBe(localTwo);
    expect(snapshotHash([{ path: "a", versionId: "ver_1" }])).not.toBe(
      snapshotHash([{ path: "a", versionId: "ver_2" }]),
    );
  });

  it("is sensitive to the path", () => {
    expect(contentRoot([{ path: "a", contentHash: "h" }])).not.toBe(
      contentRoot([{ path: "b", contentHash: "h" }]),
    );
  });

  it("returns a sha256: tag", () => {
    expect(snapshotHash([a])).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(contentRoot([{ path: "a", contentHash: "h" }])).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });
});

describe("renderHash", () => {
  it("is reproducible for identical text and excludes nothing silently", () => {
    expect(renderHash("CHRONOS CAPSULE v1\n")).toBe(renderHash("CHRONOS CAPSULE v1\n"));
    expect(renderHash("a")).not.toBe(renderHash("b"));
  });
});

describe("snapshot body", () => {
  it("round-trips through zstd", () => {
    const entries = [
      { path: "a/one", versionId: "ver_01JBQ4Q0000000000000000000" },
      { path: "b/two", versionId: "ver_01JBQ4Q0000000000000000001" },
    ];
    const decoded = decodeSnapshotBody(encodeSnapshotBody(entries));
    expect(decoded).toEqual([...entries].sort((x, y) => (x.path < y.path ? -1 : 1)));
  });

  it("refuses a body without the prefix", () => {
    expect(() => parseSnapshotText("a\u0000b\n")).toThrow(/chronos-snapshot-v1/u);
  });

  it("refuses a malformed entry", () => {
    expect(() => parseSnapshotText("chronos-snapshot-v1\nno-separator\n")).toThrow(/malformed/u);
  });
});
