import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { type SnapshotEntry, snapshotBody } from "./hash.js";

/**
 * Snapshot bodies are a canonical text form compressed with zstd. The encoding
 * is deliberately boring: decompress, split, parse. That keeps a snapshot
 * readable by any future tool without a schema negotiation.
 *
 * Node >= 22.15 ships zstd in `node:zlib`, which is the version floor in
 * `engines`, so this is not an optional capability.
 */

export function encodeSnapshotBody(entries: readonly SnapshotEntry[]): Uint8Array {
  return new Uint8Array(zstdCompressSync(Buffer.from(snapshotBody(entries), "utf8")));
}

export function decodeSnapshotBody(bytes: Uint8Array): SnapshotEntry[] {
  const text = zstdDecompressSync(Buffer.from(bytes)).toString("utf8");
  return parseSnapshotText(text);
}

export function parseSnapshotText(text: string): SnapshotEntry[] {
  const lines = text.split("\n").filter((line) => line.length > 0);
  // The first line is the version prefix, never an entry.
  if (lines.length === 0 || lines[0] !== "chronos-snapshot-v1") {
    throw new Error("snapshot body does not start with chronos-snapshot-v1");
  }
  const entries: SnapshotEntry[] = [];
  for (const line of lines.slice(1)) {
    const separator = line.indexOf("\u0000");
    if (separator <= 0 || separator === line.length - 1) {
      throw new Error(`malformed snapshot entry: ${JSON.stringify(line)}`);
    }
    entries.push({
      path: line.slice(0, separator),
      versionId: line.slice(separator + 1),
    });
  }
  return entries;
}
