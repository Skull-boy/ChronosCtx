/**
 * Deterministic node-path grammar (§4.1).
 *
 * A node path is a URI-like identifier, never an OS path. Normalisation is
 * total and idempotent; validation is strict and refuses traversal shapes
 * outright rather than relying on later sandboxing.
 */

export const NODE_PATH_MAX_CHARS = 200;
export const SEGMENT_MAX_CHARS = 48;
export const MAX_DEPTH = 6;
export const RESERVED_SEGMENTS = ["_index", "_global", "_constraints"] as const;

const SEGMENT_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;

export type PathErrorCode = "PATH_INVALID" | "PATH_RESERVED";

export type PathValidation =
  | { ok: true; path: string }
  | { ok: false; code: PathErrorCode; reason: string };

function normalizeSegment(segment: string): string {
  return segment
    .normalize("NFKC")
    .replace(/ß/gu, "ss")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[\s_]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^[.-]+|[.-]+$/gu, "");
}

/** NFKC → lowercase → diacritics stripped → spaces/underscores → "-". */
export function normalizePath(input: string): string {
  return input
    .split("/")
    .map(normalizeSegment)
    .filter((segment) => segment.length > 0)
    .join("/");
}

export function pathDepth(path: string): number {
  return path.split("/").length;
}

export function lastSegment(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? "";
}

export function parentPath(path: string): string | null {
  const index = path.lastIndexOf("/");
  return index < 0 ? null : path.slice(0, index);
}

/**
 * Deterministic collision suffix (§4.1): `-2`, `-3`, … appended to the final
 * segment, truncating the base so the segment cap still holds. The caller owns
 * creation order, so the result is reproducible rather than random.
 */
export function withCollisionSuffix(path: string, ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 2) {
    throw new RangeError("collision ordinal must be an integer >= 2");
  }
  const suffix = `-${ordinal}`;
  const parts = path.split("/");
  const head = parts.slice(0, -1);
  const base = parts[parts.length - 1] ?? "";
  const room = SEGMENT_MAX_CHARS - suffix.length;
  const trimmed = base.slice(0, Math.max(1, room)).replace(/[.-]+$/u, "");
  return [...head, `${trimmed}${suffix}`].join("/");
}

export function validatePath(input: string): PathValidation {
  if (typeof input !== "string" || input.length === 0) {
    return { ok: false, code: "PATH_INVALID", reason: "path is empty" };
  }
  if (input.includes("\0")) {
    return { ok: false, code: "PATH_INVALID", reason: "path contains NUL" };
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control characters by design
  if (/[\u0000-\u001f\u007f]/u.test(input)) {
    return { ok: false, code: "PATH_INVALID", reason: "path contains a control character" };
  }

  const rawSegments = input.split("/");
  for (const raw of rawSegments) {
    const probe = raw.trim().toLowerCase();
    if (probe.length === 0) {
      return {
        ok: false,
        code: "PATH_INVALID",
        reason: "empty segments (leading, trailing or doubled slashes) are not allowed",
      };
    }
    if ((RESERVED_SEGMENTS as readonly string[]).includes(probe)) {
      return { ok: false, code: "PATH_RESERVED", reason: `"${probe}" is a reserved node path` };
    }
    if (probe === "." || probe === "..") {
      return { ok: false, code: "PATH_INVALID", reason: "relative path segments are not allowed" };
    }
  }

  const path = normalizePath(input);
  if (path.length === 0) {
    return { ok: false, code: "PATH_INVALID", reason: "path is empty after normalisation" };
  }
  if (path.length > NODE_PATH_MAX_CHARS) {
    return {
      ok: false,
      code: "PATH_INVALID",
      reason: `path exceeds ${NODE_PATH_MAX_CHARS} characters`,
    };
  }

  const segments = path.split("/");
  if (segments.length > MAX_DEPTH) {
    return { ok: false, code: "PATH_INVALID", reason: `path exceeds ${MAX_DEPTH} segments` };
  }
  for (const segment of segments) {
    if (!SEGMENT_RE.test(segment)) {
      return {
        ok: false,
        code: "PATH_INVALID",
        reason: `segment "${segment}" does not match the path grammar`,
      };
    }
  }

  return { ok: true, path };
}

/** A project slug uses the same grammar but is always a single segment. */
export function validateSlug(input: string): PathValidation {
  const validation = validatePath(input);
  if (!validation.ok) return validation;
  if (validation.path.includes("/")) {
    return { ok: false, code: "PATH_INVALID", reason: "a slug must be a single segment" };
  }
  return validation;
}
