import { ChronosError, estimate } from "@chronos-ctx/shared-types";
import { renderHash } from "../content/hash.js";
import { parseCapsule } from "./parse.js";

/**
 * Capsule verification (ADR-0009 §6).
 *
 * `render_hash` covers the model-visible text only, never the JSON wrapper, so
 * a capsule attached to an issue can be re-checked by a third party. Line
 * endings are normalized before hashing, which keeps a Windows checkout and a
 * Linux render comparable.
 */

export interface CapsuleVerification {
  ok: boolean;
  computed: string;
  expected: string | null;
  reason: string | null;
  tokens: number;
}

const VOLATILE: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "timestamp", pattern: /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/u },
  { name: "pid", pattern: /\bpid[:=]\s*\d+/iu },
  { name: "generated-at", pattern: /\bgenerated at\b/iu },
  { name: "duration", pattern: /\bduration_ms\b/iu },
];

/** Field names or shapes that must never appear in model-visible text. */
export function findVolatileFields(text: string): string[] {
  return VOLATILE.filter((entry) => entry.pattern.test(text)).map((entry) => entry.name);
}

export function verifyCapsuleText(
  text: string,
  expected: string | null = null,
): CapsuleVerification {
  parseCapsule(text);
  const computed = renderHash(text);
  const tokens = estimate(text);

  const volatile = findVolatileFields(text);
  if (volatile.length > 0) {
    return {
      ok: false,
      computed,
      expected,
      reason: `volatile field(s) in model-visible text: ${volatile.join(", ")}`,
      tokens,
    };
  }

  if (expected === null) {
    return {
      ok: true,
      computed,
      expected: null,
      reason: "no render_hash supplied; computed only",
      tokens,
    };
  }

  const ok = computed === expected;
  return {
    ok,
    computed,
    expected,
    reason: ok ? null : "render_hash does not match the text",
    tokens,
  };
}

function nestedHash(record: Record<string, unknown>): string | null {
  const capsule = record.capsule;
  if (typeof capsule !== "object" || capsule === null) return null;
  const hash = (capsule as Record<string, unknown>).render_hash;
  return typeof hash === "string" ? hash : null;
}

/**
 * Accepts either a plain `.md` capsule or the JSON document `capsule export`
 * writes (`{ text, capsule }`). A JSON document without text is refused: the
 * hash is over text a reader sees, and there is nothing to verify without it.
 */
export function verifyCapsuleDocument(
  content: string,
  expected: string | null = null,
): CapsuleVerification {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) {
    return verifyCapsuleText(content, expected);
  }

  let document: unknown;
  try {
    document = JSON.parse(trimmed);
  } catch {
    throw new ChronosError("CAPSULE_INVALID", "file is neither capsule text nor valid JSON");
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new ChronosError("CAPSULE_INVALID", "JSON document must be an object");
  }
  const record = document as Record<string, unknown>;
  const text = record.text;
  if (typeof text !== "string") {
    throw new ChronosError(
      "CAPSULE_INVALID",
      "JSON document has no text field; the render hash covers the text, not the JSON",
    );
  }

  const hash =
    expected ?? (typeof record.render_hash === "string" ? record.render_hash : nestedHash(record));
  return verifyCapsuleText(text, hash);
}
