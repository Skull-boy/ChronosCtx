import type { Row } from "@libsql/client";

/**
 * Narrow row accessors. libSQL returns `string | number | bigint | ArrayBuffer |
 * null`, and STRICT tables guarantee a column's type, but TypeScript does not
 * know that. Reading through these helpers keeps the assertion in one place and
 * turns a schema drift into a clear error rather than a silent `undefined`.
 */

export function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new TypeError(`column ${column} is not text (got ${typeof value})`);
  }
  return value;
}

export function nullableText(row: Row, column: string): string | null {
  const value = row[column];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new TypeError(`column ${column} is not text (got ${typeof value})`);
  }
  return value;
}

export function integer(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === "bigint") return Number(value);
  if (typeof value !== "number") {
    throw new TypeError(`column ${column} is not an integer (got ${typeof value})`);
  }
  return value;
}

export function nullableInteger(row: Row, column: string): number | null {
  const value = row[column];
  if (value === null) return null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value !== "number") {
    throw new TypeError(`column ${column} is not an integer (got ${typeof value})`);
  }
  return value;
}

export function blob(row: Row, column: string): Uint8Array {
  const value: unknown = row[column];
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError(`column ${column} is not a blob (got ${typeof value})`);
}
