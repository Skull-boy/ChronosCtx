import { accounting, estimate, type TokenAccounting } from "@chronos-ctx/shared-types";

/**
 * Budget mechanics (ADR-0008).
 *
 * Two rules drive this module:
 *   1. The envelope is not free. Its own tokens are measured and counted.
 *   2. Truncation is deterministic and reported. Silent trimming is a defect.
 *
 * The envelope contains the token numbers, and adding those numbers changes its
 * own size. `renderEnvelope` iterates to a fixed point (converges in one or two
 * passes at these magnitudes) so the reported accounting matches the bytes a
 * client actually receives.
 */

const MAX_ENVELOPE_PASSES = 4;

export function measureText(text: string): number {
  return estimate(text);
}

export function tokenAccounting(
  content: number,
  envelope: number,
  schema: number,
): TokenAccounting {
  return accounting(content, envelope, schema);
}

export interface EnvelopeRendering {
  text: string;
  tokens: number;
}

export function renderEnvelope(
  make: (tokens: TokenAccounting) => string,
  content: number,
  schema: number,
): EnvelopeRendering {
  let envelope = 0;
  let text = make(tokenAccounting(content, envelope, schema));

  for (let pass = 0; pass < MAX_ENVELOPE_PASSES; pass += 1) {
    const size = measureText(text);
    if (size === envelope) return { text, tokens: size };
    envelope = size;
    text = make(tokenAccounting(content, envelope, schema));
  }

  return { text, tokens: measureText(text) };
}

/**
 * Cuts text at a boundary rather than mid-word: paragraph, then sentence, then
 * word. Returns null when even the first word does not fit.
 */
export function cutToTokens(text: string, maxTokens: number): string | null {
  if (maxTokens <= 0) return null;
  if (measureText(text) <= maxTokens) return text;

  const maxChars = Math.max(1, maxTokens * 4);
  let candidate = Array.from(text).slice(0, maxChars).join("");
  if (candidate.length === 0) return null;

  const boundaries = ["\n\n", ".\n", ".\u0020", "!\u0020", "?\u0020", "\n", "\u0020"];
  for (const boundary of boundaries) {
    const index = candidate.lastIndexOf(boundary);
    if (index >= Math.floor(candidate.length * 0.4)) {
      candidate = candidate.slice(0, index + (boundary === "\n\n" ? 0 : 1)).trimEnd();
      break;
    }
  }

  if (candidate.length === 0) return null;
  // The boundary may sit slightly above the char budget; trim until it fits.
  while (candidate.length > 0 && measureText(candidate) > maxTokens) {
    candidate = candidate.slice(0, -1).trimEnd();
  }
  return candidate.length === 0 ? null : candidate;
}

export interface FitOptions<T> {
  items: readonly T[];
  /** Renders the kept items into the body text. */
  render: (items: readonly T[]) => string;
  /** Renders the envelope for a given accounting. */
  envelope: (tokens: TokenAccounting) => string;
  schemaTokens: number;
  maxTokens: number;
  /**
   * Optional last-resort cut for a single item. Receives the content budget
   * remaining after the envelope and schema share.
   */
  cutLast?: (item: T, contentBudget: number) => T | null;
}

export interface FitResult<T> {
  items: T[];
  text: string;
  envelopeText: string;
  tokens: TokenAccounting;
  truncated: boolean;
  omittedTokens: number;
  /** False when even an empty body cannot fit the envelope and schema share. */
  fits: boolean;
}

/**
 * Fits items into `maxTokens` by dropping from the tail (the documented order in
 * §4.5.2), then cutting the final item, then dropping it. The full render is
 * measured once at the start so `omittedTokens` reports the real loss.
 */
export function fitToBudget<T>(options: FitOptions<T>): FitResult<T> {
  const fullText = options.render(options.items);
  const fullTokens = measureText(fullText);
  let items = [...options.items];

  for (let guard = 0; guard < options.items.length + 4; guard += 1) {
    const text = options.render(items);
    const content = measureText(text);
    const envelope = renderEnvelope(options.envelope, content, options.schemaTokens);
    const total = content + envelope.tokens + options.schemaTokens;

    if (total <= options.maxTokens) {
      return {
        items,
        text,
        envelopeText: envelope.text,
        tokens: tokenAccounting(content, envelope.tokens, options.schemaTokens),
        truncated: items.length !== options.items.length || content < fullTokens,
        omittedTokens: Math.max(0, fullTokens - content),
        fits: true,
      };
    }

    if (items.length > 1) {
      items = items.slice(0, -1);
      continue;
    }

    if (items.length === 1 && options.cutLast !== undefined) {
      const contentBudget = Math.max(0, options.maxTokens - envelope.tokens - options.schemaTokens);
      const cut = options.cutLast(items[0] as T, contentBudget);
      if (cut !== null) {
        const cutText = options.render([cut]);
        const cutEnvelope = renderEnvelope(
          options.envelope,
          measureText(cutText),
          options.schemaTokens,
        );
        if (measureText(cutText) + cutEnvelope.tokens + options.schemaTokens <= options.maxTokens) {
          const content = measureText(cutText);
          return {
            items: [cut],
            text: cutText,
            envelopeText: cutEnvelope.text,
            tokens: tokenAccounting(content, cutEnvelope.tokens, options.schemaTokens),
            truncated: true,
            omittedTokens: Math.max(0, fullTokens - content),
            fits: true,
          };
        }
      }
      items = [];
      continue;
    }

    if (items.length === 0) {
      const empty = options.render([]);
      const content = measureText(empty);
      const envelope = renderEnvelope(options.envelope, content, options.schemaTokens);
      return {
        items: [],
        text: empty,
        envelopeText: envelope.text,
        tokens: tokenAccounting(content, envelope.tokens, options.schemaTokens),
        truncated: true,
        omittedTokens: fullTokens,
        fits: content + envelope.tokens + options.schemaTokens <= options.maxTokens,
      };
    }
  }

  const text = options.render([]);
  const content = measureText(text);
  const envelope = renderEnvelope(options.envelope, content, options.schemaTokens);
  return {
    items: [],
    text,
    envelopeText: envelope.text,
    tokens: tokenAccounting(content, envelope.tokens, options.schemaTokens),
    truncated: true,
    omittedTokens: fullTokens,
    fits: content + envelope.tokens + options.schemaTokens <= options.maxTokens,
  };
}
