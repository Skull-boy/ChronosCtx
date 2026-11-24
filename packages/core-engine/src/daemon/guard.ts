import type { ToolErrorCode } from "@chronos-ctx/shared-types";

/**
 * Loopback HTTP guard (roadmap §3.4, gate 1.13).
 *
 * A local daemon is still reachable from a browser tab, so `Host` and `Origin`
 * are validated before any route, body read or token lookup happens. This is
 * the DNS-rebinding defence: an attacker page can resolve its own name to
 * 127.0.0.1, but it cannot make the browser send `Host: 127.0.0.1:<port>`.
 *
 * The functions here are pure. The server calls `guardRequest` once per
 * request (and again on an upgrade) and never trusts `X-Forwarded-Host`.
 */

export type GuardErrorCode = Extract<ToolErrorCode, "HOST_NOT_ALLOWED" | "ORIGIN_NOT_ALLOWED">;

/** Host names the daemon answers to. Brackets are stripped by the parser. */
export const LOOPBACK_HOSTNAMES: readonly string[] = ["127.0.0.1", "localhost", "::1"];

export interface GuardPolicy {
  /** Actual bound port. A host header with any other port is rejected. */
  port: number;
  /** Exact extension origins, for example `chrome-extension://<id>`. */
  allowedOrigins?: readonly string[];
  /**
   * Allow `http://localhost:<port>`, `http://127.0.0.1:<port>` and
   * `http://[::1]:<port>` as origins. Defaults to true. A wildcard is never
   * accepted.
   */
  allowLoopbackOrigins?: boolean;
}

export interface ParsedHost {
  hostname: string;
  port: number | null;
}

export interface GuardDecision {
  ok: boolean;
  code?: GuardErrorCode;
  message?: string;
  /** The presented Origin, or null when the client did not send one. */
  origin: string | null;
  /** Empty unless the request may receive CORS headers. */
  cors: Readonly<Record<string, string>>;
}

interface HeaderValue {
  ok: boolean;
  value: string | null;
}

function readHeader(value: string | string[] | undefined): HeaderValue {
  if (value === undefined) return { ok: true, value: null };
  if (Array.isArray(value)) {
    return value.length === 1 ? { ok: true, value: value[0] ?? null } : { ok: false, value: null };
  }
  return { ok: true, value };
}

/**
 * Parse an HTTP `Host` header into a hostname and optional port.
 *
 * Accepted forms: `127.0.0.1:4870`, `localhost:4870`, `[::1]:4870`.
 * Anything with whitespace, a comma, userinfo, a path, a query, an
 * unbracketed IPv6 literal, or a port outside 1-65535 is rejected.
 */
export function parseHostHeader(value: string): ParsedHost | null {
  if (value !== value.trim()) return null;
  const host = value;
  if (host.length === 0 || host.length > 255) return null;
  if (/[\s,/?#@]/u.test(host)) return null;

  if (host.startsWith("[")) {
    const match = /^\[([0-9A-Fa-f:.]+)\](?::(\d{1,5}))?$/u.exec(host);
    if (match === null) return null;
    const hostname = match[1];
    if (hostname === undefined) return null;
    const portText = match[2];
    const port = portText === undefined ? null : parsePort(portText);
    if (portText !== undefined && port === null) return null;
    return { hostname: hostname.toLowerCase(), port };
  }

  if (host.includes("[") || host.includes("]")) return null;

  const firstColon = host.indexOf(":");
  const lastColon = host.lastIndexOf(":");
  if (firstColon === -1) return { hostname: host.toLowerCase(), port: null };
  if (firstColon !== lastColon) return null;

  const hostname = host.slice(0, lastColon);
  const portText = host.slice(lastColon + 1);
  if (hostname.length === 0) return null;
  const port = parsePort(portText);
  if (port === null) return null;
  return { hostname: hostname.toLowerCase(), port };
}

function parsePort(text: string): number | null {
  if (!/^\d{1,5}$/u.test(text)) return null;
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

export interface HostValidation {
  ok: boolean;
  message?: string;
  parsed: ParsedHost | null;
}

/** Accept only a loopback host name and the daemon's exact port. */
export function validateHost(value: string | null | undefined, port: number): HostValidation {
  if (value === null || value === undefined) {
    return { ok: false, message: "Host header is required", parsed: null };
  }
  const parsed = parseHostHeader(value);
  if (parsed === null) {
    return { ok: false, message: "Host header is malformed", parsed: null };
  }
  if (!LOOPBACK_HOSTNAMES.includes(parsed.hostname)) {
    return {
      ok: false,
      message: `Host "${parsed.hostname}" is not a loopback name`,
      parsed,
    };
  }
  if (parsed.port === null) {
    return { ok: false, message: "Host header must include the daemon port", parsed };
  }
  if (parsed.port !== port) {
    return {
      ok: false,
      message: `Host port ${parsed.port} does not match daemon port ${port}`,
      parsed,
    };
  }
  return { ok: true, parsed };
}

export interface OriginValidation {
  ok: boolean;
  message?: string;
}

/**
 * A missing Origin is allowed because CLI and MCP stdio clients are not
 * browsers. A present Origin must match the exact allowlist or a loopback
 * origin for this port. The literal `null` origin (sandboxed iframe,
 * `file://`) is never allowed.
 */
export function validateOrigin(origin: string | null, policy: GuardPolicy): OriginValidation {
  if (origin === null) return { ok: true };
  if (origin.length === 0) return { ok: false, message: "Origin header is empty" };
  if (origin === "null") return { ok: false, message: "Origin null is not allowed" };
  if (policy.allowedOrigins?.includes(origin) === true) return { ok: true };
  if (policy.allowLoopbackOrigins !== false && isLoopbackOrigin(origin, policy.port)) {
    return { ok: true };
  }
  return { ok: false, message: `Origin "${origin}" is not allowed` };
}

export function isLoopbackOrigin(origin: string, port: number): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return false;
  if (url.port !== String(port)) return false;
  const hostname = url.hostname.toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

/** Exact CORS headers, or an empty object. Never `*`. */
export function corsHeadersFor(
  origin: string | null,
  policy: GuardPolicy,
): Readonly<Record<string, string>> {
  if (origin === null || !validateOrigin(origin, policy).ok) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, mcp-session-id",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

export interface GuardRequestInput {
  headers: {
    host?: string | string[] | undefined;
    origin?: string | string[] | undefined;
  };
  policy: GuardPolicy;
}

function failure(code: GuardErrorCode, message: string, origin: string | null): GuardDecision {
  return { ok: false, code, message, origin, cors: {} };
}

/**
 * Validate `Host` first, then `Origin`. A failed Host never reaches the route
 * table, and a failed Origin never receives CORS headers.
 */
export function guardRequest(input: GuardRequestInput): GuardDecision {
  const host = readHeader(input.headers.host);
  if (!host.ok || host.value === null) {
    return failure("HOST_NOT_ALLOWED", "Host header is required or duplicated", null);
  }
  const hostCheck = validateHost(host.value, input.policy.port);
  if (!hostCheck.ok) {
    return failure("HOST_NOT_ALLOWED", hostCheck.message ?? "Host is not allowed", null);
  }

  const origin = readHeader(input.headers.origin);
  if (!origin.ok) {
    return failure("ORIGIN_NOT_ALLOWED", "Origin header is duplicated", null);
  }
  const originCheck = validateOrigin(origin.value, input.policy);
  if (!originCheck.ok) {
    return failure(
      "ORIGIN_NOT_ALLOWED",
      originCheck.message ?? "Origin is not allowed",
      origin.value,
    );
  }

  return {
    ok: true,
    origin: origin.value,
    cors: corsHeadersFor(origin.value, input.policy),
  };
}
