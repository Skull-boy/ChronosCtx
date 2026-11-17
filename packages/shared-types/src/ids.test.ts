import { describe, expect, it } from "vitest";
import {
  createIdGenerator,
  ID_PREFIXES,
  idTimestamp,
  isId,
  isUlid,
  newId,
  parseId,
  SeededRandomSource,
  UlidFactory,
} from "./ids.js";

describe("ULID", () => {
  it("encodes 26 Crockford base32 characters", () => {
    const value = new UlidFactory().next(0);
    expect(value).toHaveLength(26);
    expect(isUlid(value)).toBe(true);
  });

  it("is lexicographically sortable by timestamp", () => {
    const factory = new UlidFactory({ random: new SeededRandomSource(7) });
    const a = factory.next(1_700_000_000_000);
    const b = factory.next(1_700_000_001_000);
    expect(a < b).toBe(true);
  });

  it("is monotonic within the same millisecond", () => {
    const factory = new UlidFactory({ random: new SeededRandomSource(7) });
    const values = Array.from({ length: 100 }, () => factory.next(1_700_000_000_000));
    const sorted = [...values].sort();
    expect(values).toEqual(sorted);
    expect(new Set(values).size).toBe(100);
  });

  it("round-trips the timestamp", () => {
    const at = 1_763_000_000_000;
    const id = createIdGenerator({ deterministic: false }).id("nod");
    expect(idTimestamp(id)).toBeGreaterThan(0);
    const fixed = new UlidFactory().next(at);
    expect(idTimestamp(`nod_${fixed}`)).toBe(at);
  });

  it("produces deterministic ids from the same seed", () => {
    const first = createIdGenerator({ deterministic: true });
    const second = createIdGenerator({ deterministic: true });
    expect(first.id("prj")).toBe(second.id("prj"));
    expect(first.id("prj")).not.toBe(first.id("prj"));
  });
});

describe("prefixed ids", () => {
  it("accepts every declared prefix", () => {
    for (const prefix of ID_PREFIXES) {
      expect(isId(newId(prefix))).toBe(true);
    }
  });

  it("rejects a malformed id", () => {
    expect(isId("prj_short")).toBe(false);
    expect(isId("xyz_01JBQ4M8Z6K2V9T3R5X7C1N0DA")).toBe(false);
    expect(() => parseId("nope")).toThrow(/malformed id/);
  });

  it("rejects Crockford-excluded letters", () => {
    // I, L, O and U are not part of the alphabet.
    expect(isUlid("01JBQ4M8Z6K2V9T3R5X7C1N0DI")).toBe(false);
    expect(isUlid("01JBQ4M8Z6K2V9T3R5X7C1N0DL")).toBe(false);
  });

  it("parses the prefix and timestamp", () => {
    const id = newId("ver");
    const parsed = parseId(id);
    expect(parsed.prefix).toBe("ver");
    expect(parsed.ulid).toHaveLength(26);
  });
});
