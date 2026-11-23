/**
 * Domain errors and their transport mappings (§4.5).
 *
 * One error type crosses every surface: MCP tools, HTTP routes, and the CLI.
 * The code union below is normative; protocol-level JSON-RPC failures are a
 * separate, smaller space.
 */

export const TOOL_ERROR_CODES = [
  "NODE_NOT_FOUND",
  "VERSION_CONFLICT",
  "EVIDENCE_REQUIRED",
  "PATH_INVALID",
  "PATH_RESERVED",
  "NODE_INVALID",
  "NODE_OVERSIZED",
  "PROJECT_NOT_FOUND",
  "BRANCH_NOT_FOUND",
  "CHECKPOINT_NOT_FOUND",
  "PROJECT_BUSY",
  "CHECKPOINT_PARTIAL",
  "RESTORE_VERIFY_FAILED",
  "CAPSULE_INVALID",
  "WORKTREE_DIRTY",
  "WRITE_REJECTED_BRANCH_QUIESCED",
  "BUDGET_EXCEEDED",
  "ALIAS_REDIRECT",
  "DAEMON_UNAVAILABLE",
  "CONFLICT",
  "EDGE_ORPHANED",
  "EVIDENCE_STALE",
  "HOST_NOT_ALLOWED",
  "ORIGIN_NOT_ALLOWED",
  "UNSAFE_FILESYSTEM",
  "PORT_RANGE_EXHAUSTED",
  "UNSUPPORTED",
  "UNAUTHORIZED",
  "INTERNAL",
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export interface ToolErrorBody {
  code: ToolErrorCode;
  message: string;
  retriable: boolean;
  retry_after_ms?: number;
  hint?: string;
  details?: Record<string, unknown>;
}

const RETRIABLE: ReadonlySet<ToolErrorCode> = new Set<ToolErrorCode>([
  "PROJECT_BUSY",
  "DAEMON_UNAVAILABLE",
  "CHECKPOINT_PARTIAL",
]);

const INVALID_PARAMS: ReadonlySet<ToolErrorCode> = new Set<ToolErrorCode>([
  "PATH_INVALID",
  "PATH_RESERVED",
  "NODE_INVALID",
  "EVIDENCE_REQUIRED",
  "EVIDENCE_STALE",
  "VERSION_CONFLICT",
  "NODE_NOT_FOUND",
  "PROJECT_NOT_FOUND",
  "BRANCH_NOT_FOUND",
  "CHECKPOINT_NOT_FOUND",
  "NODE_OVERSIZED",
  "BUDGET_EXCEEDED",
  "CAPSULE_INVALID",
  "CONFLICT",
  "UNSUPPORTED",
  "HOST_NOT_ALLOWED",
  "ORIGIN_NOT_ALLOWED",
  "UNAUTHORIZED",
]);

const HTTP_STATUS: Partial<Record<ToolErrorCode, number>> = {
  NODE_NOT_FOUND: 404,
  PROJECT_NOT_FOUND: 404,
  BRANCH_NOT_FOUND: 404,
  CHECKPOINT_NOT_FOUND: 404,
  PATH_INVALID: 400,
  PATH_RESERVED: 400,
  NODE_INVALID: 400,
  EVIDENCE_REQUIRED: 409,
  EVIDENCE_STALE: 409,
  VERSION_CONFLICT: 409,
  CONFLICT: 409,
  WORKTREE_DIRTY: 409,
  WRITE_REJECTED_BRANCH_QUIESCED: 409,
  CHECKPOINT_PARTIAL: 409,
  RESTORE_VERIFY_FAILED: 409,
  CAPSULE_INVALID: 422,
  PROJECT_BUSY: 429,
  BUDGET_EXCEEDED: 413,
  NODE_OVERSIZED: 413,
  UNAUTHORIZED: 401,
  HOST_NOT_ALLOWED: 403,
  ORIGIN_NOT_ALLOWED: 403,
  UNSAFE_FILESYSTEM: 422,
  PORT_RANGE_EXHAUSTED: 503,
  DAEMON_UNAVAILABLE: 503,
  UNSUPPORTED: 501,
  INTERNAL: 500,
};

export interface ChronosErrorOptions {
  retriable?: boolean;
  retryAfterMs?: number;
  hint?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class ChronosError extends Error {
  public readonly code: ToolErrorCode;
  public readonly retriable: boolean;
  public readonly retryAfterMs: number | undefined;
  public readonly hint: string | undefined;
  public readonly details: Record<string, unknown> | undefined;

  public constructor(code: ToolErrorCode, message: string, options: ChronosErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChronosError";
    this.code = code;
    this.retriable = options.retriable ?? RETRIABLE.has(code);
    this.retryAfterMs = options.retryAfterMs;
    this.hint = options.hint;
    this.details = options.details;
  }

  public toBody(): ToolErrorBody {
    const body: ToolErrorBody = {
      code: this.code,
      message: this.message,
      retriable: this.retriable,
    };
    if (this.retryAfterMs !== undefined) body.retry_after_ms = this.retryAfterMs;
    if (this.hint !== undefined) body.hint = this.hint;
    if (this.details !== undefined) body.details = this.details;
    return body;
  }
}

export function isChronosError(value: unknown): value is ChronosError {
  return value instanceof ChronosError;
}

/** JSON-RPC code for a domain failure. Protocol misuse stays -32602/-32603. */
export function jsonRpcCodeFor(code: ToolErrorCode): number {
  if (code === "INTERNAL") return -32603;
  if (code === "HOST_NOT_ALLOWED" || code === "ORIGIN_NOT_ALLOWED") return -32600;
  if (INVALID_PARAMS.has(code)) return -32602;
  return -32603;
}

export function httpStatusFor(code: ToolErrorCode): number {
  return HTTP_STATUS[code] ?? 500;
}

export function toToolErrorBody(error: unknown): ToolErrorBody {
  if (isChronosError(error)) return error.toBody();
  const message = error instanceof Error ? error.message : "internal error";
  return { code: "INTERNAL", message, retriable: false };
}
