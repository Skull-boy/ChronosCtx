import { createHash } from "node:crypto";

/**
 * Deterministic identity (§4.1, I7).
 *
 * Three hashes are defined here and nowhere else, because a second
 * implementation is a second identity:
 *   - `contentHash`   — identity of a node revision's text (local and portable);
 *   - `snapshotHash`  — identity of a local state map `path → version_id`;
 *   - `contentRoot`   — identity of the same knowledge on another device,
 *                       `path → content_hash`.
 *
 * Each input is prefixed with a version tag so a future encoding change is a
 * new hash rather than a silent redefinition of existing rows.
 */

export const CONTENT_HASH_PREFIX = "chronos-content-v1";
export const SNAPSHOT_HASH_PREFIX = "chronos-snapshot-v1";
export const CONTENT_ROOT_PREFIX = "chronos-content-root-v1";

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function sha256Tagged(input: string | Uint8Array): string {
  return `sha256:${sha256Hex(input)}`;
}

export interface ContentInput {
  title: string;
  summary: string;
  content: string;
}

/** `sha256("chronos-content-v1\n" + title + "\n" + summary + "\n" + content)` */
export function contentHash(input: ContentInput): string {
  return sha256Hex(`${CONTENT_HASH_PREFIX}\n${input.title}\n${input.summary}\n${input.content}`);
}

export interface SnapshotEntry {
  path: string;
  versionId: string;
}

export interface ContentRootEntry {
  path: string;
  contentHash: string;
}

/**
 * Sort by path with a plain code-unit comparison, not a locale-aware one:
 * `localeCompare` varies across ICU builds and would make the hash
 * machine-dependent.
 */
function compareByPath(a: { path: string }, b: { path: string }): number {
  if (a.path < b.path) return -1;
  if (a.path > b.path) return 1;
  return 0;
}

function canonicalBody(prefix: string, lines: string[]): string {
  if (lines.length === 0) return prefix;
  return `${prefix}\n${lines.join("\n")}\n`;
}

export function snapshotBody(entries: readonly SnapshotEntry[]): string {
  const lines = [...entries].sort(compareByPath).map((e) => `${e.path}\u0000${e.versionId}`);
  return canonicalBody(SNAPSHOT_HASH_PREFIX, lines);
}

export function snapshotHash(entries: readonly SnapshotEntry[]): string {
  return sha256Tagged(snapshotBody(entries));
}

export function contentRootBody(entries: readonly ContentRootEntry[]): string {
  const lines = [...entries].sort(compareByPath).map((e) => `${e.path}\u0000${e.contentHash}`);
  return canonicalBody(CONTENT_ROOT_PREFIX, lines);
}

export function contentRoot(entries: readonly ContentRootEntry[]): string {
  return sha256Tagged(contentRootBody(entries));
}

/** Capsule render hash: computed over model-visible text only (ADR-0009). */
export function renderHash(modelVisibleText: string): string {
  return sha256Tagged(`chronos-capsule-v1\n${normalizeCapsuleText(modelVisibleText)}`);
}

/**
 * A capsule written on Windows and read on Linux must hash identically. Line
 * endings are normalized and trailing newlines removed before hashing; the
 * visible text is unchanged for a reader.
 */
export function normalizeCapsuleText(text: string): string {
  return text.replace(/\r\n?/gu, "\n").replace(/\n+$/u, "");
}
