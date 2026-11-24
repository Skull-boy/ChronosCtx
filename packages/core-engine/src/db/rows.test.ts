import type { Row } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { blob, integer, nullableInteger, nullableText, real, text } from "./rows.js";

function row(values: Record<string, unknown>): Row {
  return values as unknown as Row;
}

describe("row accessors", () => {
  it("reads required text and refuses a mistyped column", () => {
    expect(text(row({ name: "chronos" }), "name")).toBe("chronos");
    expect(() => text(row({ name: 1 }), "name")).toThrow(TypeError);
    expect(() => text(row({ name: null }), "name")).toThrow(/is not text/u);
  });

  it("reads nullable text and refuses a mistyped non-null column", () => {
    expect(nullableText(row({ name: null }), "name")).toBeNull();
    expect(nullableText(row({ name: "chronos" }), "name")).toBe("chronos");
    expect(() => nullableText(row({ name: 1 }), "name")).toThrow(TypeError);
  });

  it("narrows integers from number and bigint", () => {
    expect(integer(row({ n: 7 }), "n")).toBe(7);
    expect(integer(row({ n: 7n }), "n")).toBe(7);
    expect(() => integer(row({ n: "7" }), "n")).toThrow(TypeError);
    expect(() => integer(row({ n: null }), "n")).toThrow(/is not an integer/u);
  });

  it("narrows nullable integers from null, number and bigint", () => {
    expect(nullableInteger(row({ n: null }), "n")).toBeNull();
    expect(nullableInteger(row({ n: 7 }), "n")).toBe(7);
    expect(nullableInteger(row({ n: 7n }), "n")).toBe(7);
    expect(() => nullableInteger(row({ n: "7" }), "n")).toThrow(TypeError);
  });

  it("narrows reals and refuses text", () => {
    expect(real(row({ n: 0.5 }), "n")).toBe(0.5);
    expect(real(row({ n: 2n }), "n")).toBe(2);
    expect(() => real(row({ n: "0.5" }), "n")).toThrow(/is not a number/u);
  });

  it("returns blobs from Uint8Array and ArrayBuffer, and refuses anything else", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(blob(row({ b: bytes }), "b")).toBe(bytes);

    const buffer = new Uint8Array([4, 5, 6]).buffer;
    const fromBuffer = blob(row({ b: buffer }), "b");
    expect(fromBuffer).toBeInstanceOf(Uint8Array);
    expect([...fromBuffer]).toEqual([4, 5, 6]);

    expect(() => blob(row({ b: "not bytes" }), "b")).toThrow(/is not a blob/u);
  });
});
