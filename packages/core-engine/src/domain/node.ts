import { ChronosError, estimate, type Warning } from "@chronos-ctx/shared-types";

/**
 * Node size and shape rules (§1.3, §4.5.3, I6). These are enforced at write time
 * so an oversized node cannot enter the graph and then distort every page-in
 * budget.
 */

/** Matches the `context_commit` schema: `content` max 200_000 characters. */
export const NODE_CONTENT_HARD_LIMIT_CHARS = 200_000;
/** Independent byte cap from §1.3 (200 KB), so multi-byte text cannot slip past. */
export const NODE_CONTENT_HARD_LIMIT_BYTES = 200 * 1024;
export const NODE_TOKEN_TARGET = 500;
export const NODE_TOKEN_HARD = 800;
export const TITLE_MAX_CHARS = 120;
export const SUMMARY_MAX_CHARS = 200;

export interface NodeText {
  title: string;
  summary: string;
  content: string;
}

export function nodeTokens(node: NodeText): number {
  return estimate(`${node.title}\n${node.summary}\n${node.content}`);
}

export interface NodeSizeReport {
  tokens: number;
  bytes: number;
  warning?: Warning;
}

/**
 * Throws `NODE_OVERSIZED` beyond the hard character cap; returns a warning above
 * the token hard cap so the writer learns to split without losing the write.
 */
export function inspectNodeSize(node: NodeText, path: string): NodeSizeReport {
  if (node.content.length > NODE_CONTENT_HARD_LIMIT_CHARS) {
    throw new ChronosError(
      "NODE_OVERSIZED",
      `node content is ${node.content.length} characters; the hard limit is ${NODE_CONTENT_HARD_LIMIT_CHARS}`,
      { hint: "Split the node by concern and page in only the part you need." },
    );
  }
  const bytes = Buffer.byteLength(node.content, "utf8");
  if (bytes > NODE_CONTENT_HARD_LIMIT_BYTES) {
    throw new ChronosError(
      "NODE_OVERSIZED",
      `node content is ${bytes} bytes; the hard limit is ${NODE_CONTENT_HARD_LIMIT_BYTES}`,
      { hint: "Split the node by concern and page in only the part you need." },
    );
  }
  const tokens = nodeTokens(node);
  if (tokens > NODE_TOKEN_HARD) {
    return {
      tokens,
      bytes,
      warning: {
        code: "NODE_OVERSIZED",
        message: `node is ~${tokens} tokens (hard ${NODE_TOKEN_HARD}); split it before it is paged in`,
        path,
      },
    };
  }
  return { tokens, bytes };
}

export interface NodeShape {
  title: string;
  summary: string;
  content: string;
}

export interface NodeShapeProblem {
  field: "title" | "summary" | "content";
  message: string;
}

export function validateNodeShape(node: NodeShape): NodeShapeProblem[] {
  const problems: NodeShapeProblem[] = [];
  if (node.title.trim().length === 0) {
    problems.push({ field: "title", message: "title must not be empty" });
  }
  if (node.title.length > TITLE_MAX_CHARS) {
    problems.push({ field: "title", message: `title exceeds ${TITLE_MAX_CHARS} characters` });
  }
  if (node.summary.trim().length === 0) {
    problems.push({ field: "summary", message: "summary must not be empty" });
  }
  if (node.summary.length > SUMMARY_MAX_CHARS) {
    problems.push({
      field: "summary",
      message: `summary exceeds ${SUMMARY_MAX_CHARS} characters (~25 tokens)`,
    });
  }
  if (node.content.trim().length === 0) {
    problems.push({ field: "content", message: "content must not be empty" });
  }
  return problems;
}
