import { describe, expect, it } from "vitest";
import {
  lastSegment,
  MAX_DEPTH,
  NODE_PATH_MAX_CHARS,
  normalizePath,
  parentPath,
  pathDepth,
  SEGMENT_MAX_CHARS,
  validatePath,
  validateSlug,
  withCollisionSuffix,
} from "./paths.js";

describe("normalizePath", () => {
  it("lowercases and kebab-cases", () => {
    expect(normalizePath("Backend/Auth JWT Spec")).toBe("backend/auth-jwt-spec");
    expect(normalizePath("tasks_active sprint")).toBe("tasks-active-sprint");
  });

  it("strips diacritics", () => {
    expect(normalizePath("Café/Résumé")).toBe("cafe/resume");
    expect(normalizePath("Über/Straße")).toBe("uber/strasse");
  });

  it("collapses separators and trims dots and dashes", () => {
    expect(normalizePath("--a----b--")).toBe("a-b");
    expect(normalizePath(".hidden.")).toBe("hidden");
  });

  it("is idempotent", () => {
    const samples = ["  A/B  ", "x__y", "Ça va/Très  bien", "a--b//c", "..", ""];
    for (const sample of samples) {
      const once = normalizePath(sample);
      expect(normalizePath(once)).toBe(once);
    }
  });
});

describe("validatePath", () => {
  it("accepts canonical paths", () => {
    for (const path of ["db/schema", "backend/auth/jwt-spec", "tasks/active-sprint"]) {
      const result = validatePath(path);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.path).toBe(path);
    }
  });

  it("returns the normalised form", () => {
    const result = validatePath("Backend/Auth  Spec");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe("backend/auth-spec");
  });

  it("refuses reserved names", () => {
    for (const path of ["_index", "_global", "_constraints", "a/_index"]) {
      const result = validatePath(path);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("PATH_RESERVED");
    }
  });

  it("refuses traversal shapes", () => {
    for (const path of ["..", "a/../b", "./x", "/etc/passwd"]) {
      const result = validatePath(path);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("PATH_INVALID");
    }
  });

  it("refuses control characters and NUL", () => {
    expect(validatePath("a\0b").ok).toBe(false);
    expect(validatePath("a\nb").ok).toBe(false);
  });

  it("enforces depth and length", () => {
    const tooDeep = Array.from({ length: MAX_DEPTH + 1 }, (_, i) => `s${i}`).join("/");
    expect(validatePath(tooDeep).ok).toBe(false);

    const tooLong = Array.from({ length: 5 }, () => "a".repeat(SEGMENT_MAX_CHARS)).join("/");
    expect(tooLong.length).toBeGreaterThan(NODE_PATH_MAX_CHARS);
    expect(validatePath(tooLong).ok).toBe(false);
  });

  it("enforces the segment charset", () => {
    expect(validatePath("a b").ok).toBe(true); // normalises to a-b
    expect(validatePath("_x").ok).toBe(true); // not a reserved name
    expect(validatePath("x/y!").ok).toBe(false);
  });
});

describe("collision suffix", () => {
  it("appends a deterministic ordinal", () => {
    expect(withCollisionSuffix("db/schema", 2)).toBe("db/schema-2");
    expect(withCollisionSuffix("db/schema", 3)).toBe("db/schema-3");
  });

  it("keeps the segment cap", () => {
    const long = "a".repeat(SEGMENT_MAX_CHARS);
    const suffixed = withCollisionSuffix(long, 12);
    expect(lastSegment(suffixed).length).toBeLessThanOrEqual(SEGMENT_MAX_CHARS);
    expect(suffixed.endsWith("-12")).toBe(true);
    expect(validatePath(suffixed).ok).toBe(true);
  });

  it("rejects ordinals below 2", () => {
    expect(() => withCollisionSuffix("a", 1)).toThrow();
  });
});

describe("path helpers", () => {
  it("reports depth, parent and leaf", () => {
    expect(pathDepth("a/b/c")).toBe(3);
    expect(parentPath("a/b/c")).toBe("a/b");
    expect(parentPath("a")).toBeNull();
    expect(lastSegment("a/b/c")).toBe("c");
  });

  it("validates slugs as single segments", () => {
    expect(validateSlug("toy-api").ok).toBe(true);
    expect(validateSlug("a/b").ok).toBe(false);
  });
});
